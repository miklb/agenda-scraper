const { Builder, By, until } = require('selenium-webdriver');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

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
 * Main scraping function
 */
async function scrapeWithSelenium(url, meetingId) {
    let driver = await new Builder().forBrowser('chrome').build();
    try {
        console.log(`Loading page: ${url}`);
        await driver.get(url);
        
        // Wait longer for the page to fully load and JavaScript to execute
        console.log('Waiting for page to fully load...');
        await new Promise(res => setTimeout(res, 5000)); // Initial wait
        
        // Get the full page source after JavaScript execution
        console.log('Getting page source after JavaScript execution...');
        let pageSource = await driver.getPageSource();
        
        // Save the full page source for debugging
        const debugDir = path.join(__dirname, 'debug');
        if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir);
        const debugFile = path.join(debugDir, `meeting_${meetingId}_full_page.html`);
        fs.writeFileSync(debugFile, pageSource);
        console.log(`Saved full page HTML to ${debugFile}`);
        
        // Load the page source into cheerio
        const $ = cheerio.load(pageSource);
        
        // Look for agenda items with proper File Numbers (using working selector)
        console.log('Searching for agenda items...');
        
        let agendaItems = [];
        
        // Look specifically for links with "File No." that are actual agenda items
        $('a[id^="lnk"]').each((i, link) => {
            const $link = $(link);
            const text = $link.text().trim();
            const href = $link.attr('href');
            const id = $link.attr('id');
            
            // Only include items that start with "File No." and look like actual agenda items
            if (text.startsWith('File No.') && text.length > 10) {
                // Extract the agenda item ID from the JavaScript href
                const agendaItemIdMatch = href && href.match(/loadAgendaItem\((\d+),/);
                const agendaItemId = agendaItemIdMatch ? agendaItemIdMatch[1] : null;
                
                agendaItems.push({
                    number: agendaItems.length + 1,
                    fileNumber: text,
                    id: id,
                    href: href,
                    agendaItemId: agendaItemId
                });
                
                console.log(`Found agenda item ${agendaItems.length}: ${text} (ID: ${id}, AgendaItemId: ${agendaItemId})`);
            }
        });
        
        console.log(`Found ${agendaItems.length} agenda items with File Numbers`);
        
        if (agendaItems.length === 0) {
            console.error(`No agenda item links found for meeting ${meetingId}`);
            return false;
        }
        
        // Now click each agenda item to get detailed information
        console.log('Clicking each agenda item to get details and supporting documents...');
        
        let orderedListItems = [];
        let supportingDocs = [];
        
        for (let i = 0; i < agendaItems.length; i++) {
            const item = agendaItems[i];
            
            try {
                console.log(`Processing item ${i + 1}/${agendaItems.length}: ${item.fileNumber}`);
                
                // Call the loadAgendaItem JavaScript function directly using the extracted ID
                if (item.agendaItemId) {
                    await driver.executeScript(`loadAgendaItem(${item.agendaItemId}, false);`);
                } else {
                    console.log(`No agendaItemId found for item ${i + 1}, trying direct click`);
                    // Fallback to direct click if no agendaItemId
                    await driver.executeScript(`
                        var element = document.getElementById('${item.id}');
                        if (element) {
                            element.click();
                        }
                    `);
                }
                
                // Wait for the #itemView section to populate
                await driver.wait(until.elementLocated(By.css('#itemView')), 10000);
                
                // Wait for content to actually load and be specific to this item
                // We'll look for the specific file number in the content to ensure it's the right item
                const expectedFileNumber = item.fileNumber.match(/File No\. ([A-Z\d-]+)/);
                const expectedFileNo = expectedFileNumber ? expectedFileNumber[1] : '';
                
                await driver.wait(async () => {
                    const itemViewHtml = await driver.findElement(By.css('#itemView')).getAttribute('innerHTML');
                    return itemViewHtml && 
                           itemViewHtml.trim().length > 100 && 
                           itemViewHtml.includes('item-view-title-text') &&
                           (expectedFileNo === '' || itemViewHtml.includes(expectedFileNo));
                }, 15000);
                
                // Get the populated content
                const itemViewHtml = await driver.findElement(By.css('#itemView')).getAttribute('innerHTML');
                const $itemView = cheerio.load(itemViewHtml);
                
                // Extract the full description
                const fullDescription = $itemView('.item-view-title-text').text().trim();
                const finalItemText = fullDescription || item.fileNumber;
                
                orderedListItems.push(finalItemText);
                
                // Extract supporting document links
                const docLinks = [];
                $itemView('a[href*="DownloadFile"]').each((j, docLink) => {
                    const $docLink = $itemView(docLink);
                    const href = $docLink.attr('href');
                    const title = $docLink.attr('title') || '';
                    const text = $docLink.text().trim();
                    if (href) {
                        docLinks.push({ href, title, text });
                    }
                });
                supportingDocs.push(docLinks);
                
            } catch (err) {
                console.error(`Error extracting Item Details for agenda item ${i+1}:`, err.message);
                orderedListItems.push(item.fileNumber);
                supportingDocs.push([]);
            }
        }
        // --- Output logic: append supporting docs if found ---
        let markdownContent = orderedListItems.map((item, index) => {
            let cleanedItem = cleanAgendaContent(item);
            // Add supporting docs as links
            if (supportingDocs[index] && supportingDocs[index].length) {
                cleanedItem += '\n\nSupporting documents:';
                supportingDocs[index].forEach(doc => {
                    cleanedItem += `\n- [${doc.text || doc.title || 'Document'}](${doc.href.startsWith('http') ? doc.href : 'https://tampagov.hylandcloud.com' + doc.href.replace(/&amp;/g, '&')})`;
                });
            }
            if (/^\d+\./.test(cleanedItem)) {
                return cleanedItem;
            }
            return `${index + 1}. ${cleanedItem}`;
        }).join('\n\n');

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
        
        // Find all unique data-meeting-id attributes for <tr> where the last <td> includes an "Agenda" href (not "Summary")
        let meetingIds = new Set();
        $('#meetings-list-upcoming table:first-of-type tr').each((i, tr) => {
            let lastTd = $(tr).find('td').last();
            let links = lastTd.find('a[href]');
            
            // Check if any link in this row contains "Agenda" and NOT "Summary"
            let hasAgendaLink = false;
            links.each((j, link) => {
                let linkText = $(link).text().trim().toLowerCase();
                let linkHref = $(link).attr('href') || '';
                
                // Include if:
                // 1. Link text contains "agenda" but not "summary"
                // 2. Link href contains "doctype=1" (which is agenda) but text doesn't contain "summary"
                if ((linkText.includes('agenda') && !linkText.includes('summary')) ||
                    (linkHref.includes('doctype=1') && !linkText.includes('summary'))) {
                    hasAgendaLink = true;
                }
            });
            
            if (hasAgendaLink) {
                let meetingId = $(tr).attr('data-meeting-id');
                if (meetingId) {
                    // Explicitly exclude known summary meeting IDs
                    if (meetingId === '2651') {
                        console.log(`Excluding meeting ${meetingId} (appears to be a Summary link)`);
                    } else {
                        meetingIds.add(meetingId);
                    }
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
        // Use the correct rendered agenda URL
        let meetingUrl = `https://tampagov.hylandcloud.com/221agendaonline/Meetings/ViewMeeting?id=${meetingId}&doctype=1`;
        console.log(`Scraping meeting ID: ${meetingId} with URL: ${meetingUrl}`);
        await scrapeWithSelenium(meetingUrl, meetingId);
    }
}

// Call the main function
if (require.main === module) {
    main();
}

// Export functions for testing
module.exports = {
    scrapeMeetingIds,
    scrapeWithSelenium
};