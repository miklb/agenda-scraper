const { Builder, By, until } = require('selenium-webdriver');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pdfParse = require('pdf-parse');

function debugCharCodes(str) {
    return Array.from(str).map(char => `${char}: ${char.charCodeAt(0)}`).join('\n');
}

/**
 * Extract dollar amounts from agenda items and generate a table
 * @param {string} markdownContent - The markdown content of the agenda
 * @returns {string} - A markdown table with agenda numbers, amounts, and total
 */
function extractDollarAmounts(markdownContent) {
    const lines = markdownContent.split('\n');
    const dollarRegex = /\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g; // Matches dollar amounts like $208,788.00
    const tableRows = [];
    let totalAmount = 0;

    lines.forEach((line, index) => {
        const agendaNumberMatch = line.match(/^\d+\./); // Matches agenda numbers like "1."
        const dollarMatches = line.match(dollarRegex); // Find all dollar amounts in the line

        if (agendaNumberMatch && dollarMatches) {
            const agendaNumber = agendaNumberMatch[0].replace('.', ''); // Extract agenda number
            dollarMatches.forEach(amount => {
                const numericValue = parseFloat(amount.replace(/[$,]/g, '')); // Convert to a number
                totalAmount += numericValue; // Add to the total
                tableRows.push(`| ${agendaNumber} | ${amount} |`); // Add to the table
            });
        }
    });

    // Generate the markdown table
    let table = `| Agenda # | Amount |\n|----------|--------|\n`;
    table += tableRows.join('\n');
    table += `\n| **Total** | **$${totalAmount.toLocaleString()}** |`;

    return table;
}

/**
 * Clean up redundant legalese text from agenda items
 * @param {string} content - The raw agenda content
 * @returns {string} - Cleaned agenda content
 */
function cleanAgendaContent(content) {
    // First preserve file numbers with proper formatting
    let cleaned = content
        // Format file numbers consistently
        .replace(/(File No\. (DE[12]-\d{2}-\d{2}(?:-[A-Z])?|TA\/CPA\d{2}-\d{2}|REZ-\d{2}-\d{2}|VAC-\d{2}-\d{4}|AB[12]-\d{2}-\d{2}|SU\d?-\d{2}-\d{2}))/gi, '**$1**')
        
        // Remove memorandum notes
        .replace(/\s*Memorandum from [^\.]+?\.[^\.]+?\./gi, '')
        .replace(/\s*Email from [^\.]+?\.[^\.]+?\./gi, '')
        
        // Normalize spacing
        .replace(/\s+/g, ' ').trim()
        
        // Remove parenthetical notes - these don't change meaning
        .replace(/\(Ordinance being presented[^)]*\)/gi, '')
        .replace(/\(To be R\/F\)/gi, '')
        .replace(/\(Updated[^)]*\)/gi, '')
        .replace(/\(Original [Mm]otion[^)]*\)/gi, '')
        .replace(/\(Continued from[^)]*\)/gi, '')
        .replace(/\(Motion to reschedule[^)]*\)/gi, '')
        .replace(/\(Motion adopting[^)]*\)/gi, '')
        .replace(/\(Motion requesting[^)]*\)/gi, '')
        .replace(/\(Amended motion[^)]*\)/gi, '')
        .replace(/\(Next [^)]*\)/gi, '')
        .replace(/\(First (discussion|public hearing)[^)]*\)/gi, '')
        
        // Remove ONLY standard ending phrases - these are truly boilerplate
        .replace(/;\s*providing an effective date\.?$/gi, '.')
        .replace(/;\s*providing for severability\.?$/gi, '.')
        .replace(/;\s*providing for repeal of all ordinances in conflict\.?$/gi, '.')
        .replace(/;\s*repealing conflicts\.?$/gi, '.')
        
        // Handle all variations of authorization phrases - expanded to catch more patterns
        .replace(/;\s*authorizing the Director of Purchasing to purchase said property, supplies, materials or services\.?$/gi, '.')
        .replace(/;\s*authorizing the Mayor(?: of the City of Tampa)? to execute (?:same|said agreement|said Amendment|said Change Order)(?: on behalf of the City of Tampa)?\.?$/gi, '.')
        .replace(/;\s*authorizing execution(?: thereof)? by the Mayor(?: of the City of Tampa)?(?: and attestation by the (?:City )?Clerk)?\.?$/gi, '.')
        .replace(/;\s*authorizing the execution thereof by the Mayor(?: of the City of Tampa)?(?: and attestation by the (?:City )?Clerk)?\.?$/gi, '.')
        .replace(/;\s*authorizing execution by the Mayor and attestation by the City Clerk\.?$/gi, '.')
        
        // Fix any punctuation issues
        .replace(/,\s*;/g, ';')
        .replace(/,\s*\./g, '.')
        .replace(/:\s*\./g, '.')
        .replace(/;\s*\./g, '.')
        .replace(/\.\s*\.$/g, '.'); // Fix double periods
        
    // Ensure ends with period if not already (but check more carefully)
    if (cleaned && !/[.?!]$/.test(cleaned.trim())) {
        cleaned += '.';
    }
    
    // Final check for double periods
    cleaned = cleaned
        .replace(/\.\s*\.$/g, '.')  // Fix double periods at end
        .replace(/\.\s+\.$/g, '.'); // Fix period-space-period at end
    
    return cleaned;
}

/**
 * Simplified PDF extraction with better error handling
 */
async function extractBackgroundFromPDF(pdfUrl) {
    try {
        console.log(`Downloading PDF: ${pdfUrl}`);
        
        // First, check what we're actually getting
        const headResponse = await axios.head(pdfUrl);
        console.log(`Content-Type: ${headResponse.headers['content-type']}`);
        console.log(`Content-Length: ${headResponse.headers['content-length']}`);
        
        // If it's not a PDF, skip
        if (!headResponse.headers['content-type']?.includes('pdf')) {
            console.log('Response is not a PDF file');
            return "Summary sheet is not available as a PDF file.";
        }
        
        // Download the actual PDF
        const response = await axios.get(pdfUrl, { 
            responseType: 'arraybuffer',
            timeout: 10000, // 10 second timeout
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            }
        });
        
        console.log(`Downloaded ${response.data.byteLength} bytes`);
        
        // Check if the downloaded data looks like a PDF
        const pdfHeader = response.data.slice(0, 5);
        const headerString = String.fromCharCode(...pdfHeader);
        
        if (!headerString.startsWith('%PDF')) {
            console.log('Downloaded file does not have PDF header');
            return "Downloaded file is not a valid PDF.";
        }
        
        // Try to parse with pdf-parse
        const data = await pdfParse(response.data);
        const text = data.text;
        
        console.log(`Extracted ${text.length} characters from PDF`);
        
        // Look for background section
        const backgroundMatch = text.match(/BACKGROUND:(.*?)(?:RECOMMENDATION:|FISCAL IMPACT:|$)/s);
        
        if (backgroundMatch && backgroundMatch[1]) {
            const background = backgroundMatch[1].trim();
            console.log(`Found background section: ${background.substring(0, 100)}...`);
            return background;
        } else {
            console.log('No BACKGROUND: section found in PDF text');
            // Log first 500 chars to see what we got
            console.log(`PDF text preview: ${text.substring(0, 500)}`);
            return "No background section found in the summary sheet.";
        }
        
    } catch (error) {
        console.error(`Error extracting background from PDF ${pdfUrl}:`, error.message);
        
        if (error.code === 'ECONNRESET' || error.code === 'ENOTFOUND') {
            return "Network error while downloading summary sheet.";
        } else if (error.message.includes('Invalid PDF')) {
            return "Summary sheet PDF file appears to be corrupted or invalid.";
        } else {
            return "Unable to retrieve background information from the summary sheet.";
        }
    }
}

/**
 * Gets the summary sheet URL for a specific agenda item
 * @param {string} meetingId - The meeting ID
 * @param {string} itemId - The agenda item ID
 * @param {string} publishId - The publish ID (required parameter)
 * @returns {string} - URL to the summary sheet PDF
 */
function getSummarySheetUrl(meetingId, itemId, publishId) {
    return `https://tampagov.hylandcloud.com/221agendaonline/Documents/DownloadFileBytes/Summary%20Sheet-%20COVER%20SHEET.pdf?documentType=1&meetingId=${meetingId}&itemId=${itemId}&publishId=${publishId}&isSection=False&isAttachment=True`;
}

/**
 * Main scraping function
 */
async function scrapeWithSelenium(url, meetingId) {
    let driver = await new Builder().forBrowser('chrome').build();
    
    try {
        await driver.get(url);
        
        // Wait for content to load
        await driver.wait(until.elementLocated(By.css('table')), 10000);
        
        let pageSource = await driver.getPageSource();
        const $ = cheerio.load(pageSource);
        
        // Initialize an array to hold the ordered list items and their IDs
        let orderedListItems = [];
        let itemIds = [];
        
        // Verify tables exist
        const tables = $('table');
        if (tables.length === 0) {
            console.error(`No tables found for meeting ${meetingId}`);
            return false;
        }
        
        // Find all tables with the specified structure
        tables.each((i, table) => {
            const hasNumberSpan = $(table).find('td > p > span').filter((i, span) => {
                return /^\d+\.$/.test($(span).text().trim());
            }).length > 0;
            
            if (hasNumberSpan) {
                // Extract the table content and preserve structure
                let combinedContent = '';
                let itemId = null;
                let publishId = null;
                
                // Look for JavaScript links with loadAgendaItem function
                const jsLinks = $(table).find('a[href^="javascript:loadAgendaItem"]');
                if (jsLinks.length > 0) {
                    jsLinks.each((j, link) => {
                        if (itemId) return; // Skip if we already found an ID
                
                        const href = $(link).attr('href');
                        // Extract item ID from loadAgendaItem(ID,false) pattern
                        const itemIdMatch = href.match(/loadAgendaItem\((\d+),/);
                        if (itemIdMatch && itemIdMatch[1]) {
                            itemId = itemIdMatch[1];
                            console.log(`Found itemId ${itemId} from JavaScript loadAgendaItem function`);
                        }
                    });
                }
                
                // Look specifically for summary sheet PDF links to get publishId
                const summarySheetLinks = $(table).find('a[href*="Summary%20Sheet-%20COVER%20SHEET"], a[href*="Summary Sheet- COVER SHEET"]');
                if (summarySheetLinks.length > 0) {
                    summarySheetLinks.each((j, link) => {
                        const href = $(link).attr('href');
                
                        // Extract itemId if we don't have it yet
                        if (!itemId) {
                            const itemIdMatch = href.match(/[&?]itemId=(\d+)/i);
                            if (itemIdMatch && itemIdMatch[1]) {
                                itemId = itemIdMatch[1];
                                console.log(`Found itemId ${itemId} from summary sheet PDF link`);
                            }
                        }
                
                        // Extract publishId
                        const publishIdMatch = href.match(/[&?]publishId=(\d+)/i);
                        if (publishIdMatch && publishIdMatch[1]) {
                            publishId = publishIdMatch[1];
                            console.log(`Found publishId ${publishId} from summary sheet PDF link`);
                        }
                    });
                }
                
                // Process content
                $(table).find('td').each((i, td) => {
                    let fileNoText = '';
                    let descriptionText = '';
                    
                    $(td).find('p').each((j, p) => {
                        let text = $(p).text().trim();
                        if (text) {
                            if (text.includes('File No.')) {
                                fileNoText = text;
                            } else {
                                descriptionText += text + ' ';
                            }
                        }
                    });
                    
                    if (fileNoText || descriptionText) {
                        combinedContent += (fileNoText ? fileNoText + ' ' : '') + descriptionText.trim() + '\n';
                    }
                });
                
                if (combinedContent.trim()) {
                    orderedListItems.push(combinedContent.trim());
                    // Store both itemId and publishId
                    itemIds.push({ itemId, publishId });
                }
            }
        });
        
        // Alternative approach: Search the entire page for summary sheet links
        if (itemIds.some(id => id === null)) {
            console.log("Some items are missing IDs, searching entire page for summary sheet links...");
            
            // Find ALL summary sheet links on the page
            const allSummarySheetLinks = $('a[href*="Summary%20Sheet-%20COVER%20SHEET"], a[href*="Summary Sheet- COVER SHEET"]');
            console.log(`Found ${allSummarySheetLinks.length} summary sheet links on the page`);
            
            const foundItemIds = [];
            allSummarySheetLinks.each((i, link) => {
                const href = $(link).attr('href');
                const itemIdMatch = href.match(/[&?]itemId=(\d+)/i);
                if (itemIdMatch && itemIdMatch[1]) {
                    foundItemIds.push(itemIdMatch[1]);
                    console.log(`Summary sheet link ${i+1}: itemId=${itemIdMatch[1]}`);
                }
            });
            
            // Try to match found IDs to agenda items that don't have IDs
            let idIndex = 0;
            for (let i = 0; i < itemIds.length; i++) {
                if (itemIds[i] === null && idIndex < foundItemIds.length) {
                    itemIds[i] = foundItemIds[idIndex++];
                    console.log(`Assigned itemId ${itemIds[i]} to agenda item ${i+1}`);
                }
            }
        }
        
        // Verify content was extracted
        if (orderedListItems.length === 0) {
            console.error(`No content extracted for meeting ${meetingId}`);
            return false;
        }

        // Download and extract background sections from PDFs where we have item IDs
        const backgroundSections = [];
        for (let i = 0; i < itemIds.length; i++) {
            if (itemIds[i] && itemIds[i].itemId && itemIds[i].publishId) {
                const pdfUrl = getSummarySheetUrl(meetingId, itemIds[i].itemId, itemIds[i].publishId);
                console.log(`Getting background for item ${i+1} (ID: ${itemIds[i].itemId}, PublishID: ${itemIds[i].publishId}): ${pdfUrl}`);
                const background = await extractBackgroundFromPDF(pdfUrl);
                backgroundSections[i] = background;
            } else {
                console.log(`Missing itemId or publishId for agenda item ${i+1}`);
                backgroundSections[i] = "No item ID or publish ID available to retrieve background information.";
            }
        }

        // Generate WordPress file from the raw orderedListItems before any processing
        generateWordPressOutput(orderedListItems, meetingId, url, backgroundSections);

        // After extracting and cleaning the content
        let markdownContent = orderedListItems.map((item, index) => {
            // Clean up legalese text
            let cleanedItem = cleanAgendaContent(item);

            // Add background section if available
            if (backgroundSections[index]) {
                cleanedItem += `\n\n**Background:** ${backgroundSections[index]}`;
            }

            // Ensure no duplicate numbering
            if (/^\d+\./.test(cleanedItem)) {
                return cleanedItem; // Item already starts with a number
            }

            // Format as a proper markdown list item with index+1 as the number
            return `${index + 1}. ${cleanedItem}`;
        }).join('\n\n'); // Double line break for cleaner WordPress import

        // Extract file numbers and their list numbers
        const fileNumberMatches = markdownContent.match(/\d+\.\s+\*\*File No\. ([A-Z\/]+(?:[12])?-\d+-\d+(?:-[A-Z])?)\*\*/g) || [];
        const csvPairs = fileNumberMatches.map((match) => {
            const fileNo = match.match(/([A-Z\/]+(?:[12])?-\d+-\d+(?:-[A-Z])?)/)[1];
            // Split on last dash and pad number with zeros
            const [prefix, num] = fileNo.split(/-(?=[^-]+$)/);
            const paddedNum = num.padStart(7, '0');
            const paddedFileNo = `${prefix}-${paddedNum}`;
            // Extract list number from the beginning of the match
            const listNumber = match.match(/^(\d+)\./)[1];
            return `${paddedFileNo}:${listNumber}`;
        });

        // Add CSV list to bottom of content if matches found
        if (csvPairs.length > 0) {
            markdownContent += '\n\n' + csvPairs.join(', ');
        }

        // Extract dollar amounts and generate a table
        const dollarTable = extractDollarAmounts(markdownContent);

        // Add the dollar table to the markdown content
        markdownContent += `\n\n---\n\n${dollarTable}`;

        // Add source URL at the bottom
        markdownContent += '\n\n---\n*Source: [Original Agenda Document](' + url + ')*';

        // Only write file if content exists
        if (markdownContent.trim()) {
            const outputDir = path.join(__dirname, 'agendas');
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir);
            }
            
            let outputFileName = path.join(outputDir, `agenda_${meetingId}.md`);
            fs.writeFileSync(outputFileName, markdownContent);
            
            console.log(`Successfully created: ${outputFileName}`);
            
            return true;
        } else {
            console.error(`Empty content generated for meeting ${meetingId}`);
            return false;
        }
    } catch (error) {
        console.error(`Error scraping meeting ${meetingId}:`, error);
        return false;
    } finally {
        await driver.quit();
    }
}

async function scrapeMeetingIds(url) {
    // Set up the Selenium WebDriver
    let driver = await new Builder().forBrowser('chrome').build();
    
    try {
        // Load the page
        await driver.get(url);
        
        // Wait for the #meetings-list-upcoming element to be loaded
        await driver.wait(until.elementLocated(By.id('meetings-list-upcoming')), 10000);
        
        // Extract the page source
        let pageSource = await driver.getPageSource();
        
        // Load the page source into cheerio
        const $ = cheerio.load(pageSource);
        
        // Find all unique data-meeting-id attributes for <tr> where the last <td> includes an href
        let meetingIds = new Set();
        $('#meetings-list-upcoming table:first-of-type tr').each((i, tr) => {
            let lastTd = $(tr).find('td').last();
            if (lastTd.find('a[href]').length > 0) {
                let meetingId = $(tr).attr('data-meeting-id');
                if (meetingId) {
                    meetingIds.add(meetingId);
                }
            }
        });
        
        // Convert the set to an array and log the unique meeting IDs
        let uniqueMeetingIds = Array.from(meetingIds);
        console.log('Unique meeting IDs:', uniqueMeetingIds);
        
        return uniqueMeetingIds;
    } finally {
        // Quit the driver
        await driver.quit();
    }
}

function generateWordPressOutput(orderedListItems, meetingId, sourceUrl, backgroundSections = []) {
  // Transform the URL to the correct format
  const correctedUrl = sourceUrl
    .replace('/Documents/ViewAgenda', '/Meetings/ViewMeeting')
    .replace('meetingId=', 'id=')
    .replace('&type=agenda', '');
  
  // Generate the intro blocks with the corrected URL
  let wpHtml = `<!-- wp:paragraph -->
<p>This version of the agenda is meant to be an easier way to skim the items before diving into the full draft and back up items. It also is meant as an archive for search. Often I remember something being on the agenda but not sure when. While the ongoing work with Onbase continues, and there is some search functionality here I can cross reference with agenda previews, then look at the original agenda.</p>
<!-- /wp:paragraph -->

<!-- wp:group {"layout":{"type":"flex","flexWrap":"nowrap"}} -->
<div class="wp-block-group"><!-- wp:coblocks/icon {"icon":"page","href":"${correctedUrl}"} /-->

<!-- wp:paragraph {"fontSize":"large"} -->
<p class="has-large-font-size"><a href="${correctedUrl}">Draft Agenda</a></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->\n\n`;
  
  // Process items to identify where the split should occur
  const processedItems = [];
  let firstStrongIndex = -1;
  
  // Extract file numbers for the map
  const fileNumberMatches = [];
  
  // Process each item and track the first occurrence of <strong>
  orderedListItems.forEach((item, index) => {
    let cleanedText = cleanAgendaContent(item);
    
    let itemNumber = index + 1;
    let numberMatch = cleanedText.match(/^(\d+)\./);
    if (numberMatch) {
      itemNumber = numberMatch[1];
      cleanedText = cleanedText.replace(/^\d+\./, '').trim();
    }
    
    // Add background section if available
    if (backgroundSections[index]) {
      cleanedText += `\n\n<p class="has-background has-pale-pink-background-color"><strong>Background:</strong> ${backgroundSections[index]}</p>`;
    }
    
    // Check if this item will have a strong tag after conversion
    const hasStrongTag = /\*\*File No\. (DE[12]|TA\/CPA|REZ|VAC|AB[12]|SU\d?)/i.test(cleanedText);
    
    // If this has a strong tag, extract the file number and list number for the map
    if (hasStrongTag) {
      const fileNoMatch = cleanedText.match(/\*\*File No\. ([A-Z\/\d-]+)\*\*/);
      if (fileNoMatch) {
        const fileNo = fileNoMatch[1];
        // Split on last dash and pad number with zeros
        const [prefix, num] = fileNo.split(/-(?=[^-]+$)/);
        const paddedNum = num.padStart(7, '0');
        const paddedFileNo = `${prefix}-${paddedNum}`;
        fileNumberMatches.push(`${paddedFileNo}:${itemNumber}`);
      }
    }
    
    // Convert markdown bold syntax to HTML strong tags
    cleanedText = cleanedText.replace(/\*\*(File No\. (DE[12]-\d{2}-\d{2}(?:-[A-Z])?|TA\/CPA\d{2}-\d{2}|REZ-\d{2}-\d{2}|VAC-\d{2}-\d{4}|AB[12]-\d{2}-\d{2}|SU\d?-\d{2}-\d{2}))\*\*/gi, '<strong>$1</strong>');
    
    // Store the processed item
    processedItems.push({ itemNumber, cleanedText, hasStrongTag });
    
    // Track the first occurrence of a strong tag
    if (hasStrongTag && firstStrongIndex === -1) {
      firstStrongIndex = processedItems.length - 1;
    }
  });
  
  // If we found a strong tag, split the list
  if (firstStrongIndex !== -1) {
    // First part of the list - using WordPress block format
    wpHtml += `<!-- wp:list {"ordered":true} -->\n<ol class="wp-block-list">\n`;
    for (let i = 0; i < firstStrongIndex; i++) {
      const { cleanedText } = processedItems[i];
      wpHtml += `<!-- wp:list-item -->\n<li>${cleanedText}</li>\n<!-- /wp:list-item -->\n`;
    }
    wpHtml += `</ol>\n<!-- /wp:list -->\n\n`;
    
    // Add heading for Public Hearings & Ordinances
    wpHtml += `<!-- wp:heading {"level":3} -->\n<h3>Public Hearings & Ordinances</h3>\n<!-- /wp:heading -->\n\n`;
    
    // Add the map block using the extracted file numbers
    if (fileNumberMatches.length > 0) {
      const recordsStr = fileNumberMatches.join(', ');
      wpHtml += `<!-- wp:map-current-dev/block {"apiToken":"pk.eyJ1IjoibWlrbGIiLCJhIjoiY2x6OThxcWlwMDB2ajJrcTR3dGJkNjBpOCJ9.x64atltv8LBQAjtuGTUvrA","records":"${recordsStr}"} -->
<div class="wp-block-map-current-dev-block mapbox-block" data-token="pk.eyJ1IjoibWlrbGIiLCJhIjoiY2x6OThxcWlwMDB2ajJrcTR3dGJkNjBpOCJ9.x64atltv8LBQAjtuGTUvrA" data-center="[-82.4572,27.9506]" data-zoom="11" data-geojson-endpoint="https://arcgis.tampagov.net/arcgis/rest/services/OpenData/Planning/MapServer/31/query?outFields=*&amp;where=1%3D1&amp;f=geojson" data-records="${recordsStr}" data-show-geocoder="true" data-geocoder-position="top-right" data-show-legend="true" data-legend-position="bottom-left"></div>
<!-- /wp:map-current-dev/block -->\n\n`;
    }
    
    // Add Tampa zoning map reference block
    wpHtml += `<!-- wp:paragraph -->
<p>If you've missed it, I have a map for city of Tampa current zoning and Future Land Use designations.</p>
<!-- /wp:paragraph -->

<!-- wp:buttons -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="https://tampamonitor.com/tampa-land-use-map/">City of Tampa Zoning Map</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons -->\n\n`;
    
    // Second part of the list using WordPress block format with start attribute
    const startNumber = processedItems[firstStrongIndex].itemNumber;
    wpHtml += `<!-- wp:list {"ordered":true,"start":${startNumber}} -->\n<ol start="${startNumber}" class="wp-block-list">\n`;
    for (let i = firstStrongIndex; i < processedItems.length; i++) {
      const { cleanedText } = processedItems[i];
      wpHtml += `<!-- wp:list-item -->\n<li>${cleanedText}</li>\n<!-- /wp:list-item -->\n`;
    }
    wpHtml += `</ol>\n<!-- /wp:list -->\n`;
  } else {
    // Single list - WordPress block format
    wpHtml += `<!-- wp:list {"ordered":true} -->\n<ol class="wp-block-list">\n`;
    processedItems.forEach(({ cleanedText }) => {
      wpHtml += `<!-- wp:list-item -->\n<li>${cleanedText}</li>\n<!-- /wp:list-item -->\n`;
    });
    wpHtml += `</ol>\n<!-- /wp:list -->\n`;
  }
  
  // Write the WordPress HTML file
  const outputDir = path.join(__dirname, 'agendas');
  let outputFileName = path.join(outputDir, `agenda_${meetingId}.wp.html`);
  fs.writeFileSync(outputFileName, wpHtml);
  
  console.log(`Successfully created WordPress-compatible file: ${outputFileName}`);
}

async function main() {
    // URL of the page to scrape for meeting IDs
    let url = 'https://tampagov.hylandcloud.com/221agendaonline/';
    
    // Get unique meeting IDs
    let uniqueMeetingIds = await scrapeMeetingIds(url);
    
    // Scrape each meeting ID sequentially
    for (let meetingId of uniqueMeetingIds) {
        let meetingUrl = `https://tampagov.hylandcloud.com/221agendaonline/Documents/ViewAgenda?meetingId=${meetingId}&type=agenda&doctype=1`;
        console.log(`Scraping meeting ID: ${meetingId} with URL: ${meetingUrl}`);
        await scrapeWithSelenium(meetingUrl, meetingId);
    }
}

// Call the main function
main();