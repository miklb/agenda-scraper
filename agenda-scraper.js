const { Builder, By, until } = require('selenium-webdriver');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const { generateWordPressOutput, cleanAgendaContent } = require('./wordpress-functions');
const { toTitleCase } = require('./format-helpers');

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
    let inBackgroundSection = false;

    lines.forEach((line, index) => {
        // Check if we're entering a Background section
        if (line.trim().startsWith('**Background:**')) {
            inBackgroundSection = true;
            return;
        }
        
        // Check if we're exiting the Background section (next main agenda item)
        // Main agenda items start with number followed by period and "File No."
        if (inBackgroundSection && line.match(/^\d+\.\s+(?:\*\*)?File No\./)) {
            inBackgroundSection = false;
        }
        
        // Also exit background section when we hit Supporting documents
        if (inBackgroundSection && line.trim().startsWith('Supporting documents:')) {
            inBackgroundSection = false;
            return; // Don't process this line
        }
        
        // Skip lines that are within Background sections
        if (inBackgroundSection) {
            return;
        }

        // Only process main agenda items (lines that start with number and contain "File No.")
        const agendaNumberMatch = line.match(/^(\d+)\.\s+(?:\*\*)?File No\./);
        const dollarMatches = line.match(dollarRegex);

        if (agendaNumberMatch && dollarMatches) {
            const agendaNumber = agendaNumberMatch[1]; // Extract agenda number
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
 * Format a date string for use in filenames (converts to YYYY-MM-DD format)
 * @param {string} dateStr - Date string in various formats
 * @returns {string} - Formatted date string or empty string if invalid
 */
function formatDateForFilename(dateStr) {
    if (!dateStr) return '';
    
    try {
        // Handle common date formats
        let date;
        
        // Try parsing MM/DD/YYYY format
        const mmddyyyy = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (mmddyyyy) {
            const [, month, day, year] = mmddyyyy;
            date = new Date(year, month - 1, day);
        }
        // Try parsing YYYY-MM-DD format
        else if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
            date = new Date(dateStr);
        }
        // Try parsing "Month DD, YYYY" format
        else {
            date = new Date(dateStr);
        }
        
        // Validate the date
        if (isNaN(date.getTime())) {
            return '';
        }
        
        // Format as YYYY-MM-DD
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        
        return `${year}-${month}-${day}`;
    } catch (error) {
        return '';
    }
}

/**
 * Format background text to properly structure numbered lists and improve readability
 * @param {string} text - Raw background text from PDF
 * @returns {string} - Formatted background text
 */
function formatBackgroundText(text) {
    if (!text || text.trim().length === 0) return text;
    
    // Structure-based PDF formatting - trust the PDF parser's output
    // Only clean up obvious PDF artifacts that don't affect structure
    let cleanText = text
        // Fix split dollar amounts like "$452,\n962.55" -> "$452,962.55"  
        .replace(/\$(\d{1,3}(?:,\d{3})*),\s*\n\s*(\d{3}(?:\.\d{2})?)/g, '$$$1,$2')
        // Fix split document references like "R\n1182" -> "R1182"
        .replace(/\b(Resolution|Contract|Case|File|R)\s*\n\s*(\d+)/gi, '$1$2')
        // Fix split contract numbers, case numbers, etc.
        .replace(/(\b(?:Contract|Resolution|Case|File|No\.?|Number))\s*\n\s*([A-Z0-9-]+)/gi, '$1 $2')
        // Fix split dates like "01/05/\n2024" -> "01/05/2024"
        .replace(/(\d{1,2}\/\d{1,2}\/)\s*\n\s*(\d{4})/g, '$1$2')
        .trim();
    
    // Use the PDF's natural structure: split on lines and analyze the structure
    const lines = cleanText.split('\n');
    const processedLines = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        // Check if this line starts a numbered item
        if (/^\d+\.\s+/.test(line)) {
            // This is a numbered item - add with separation
            if (processedLines.length > 0) {
                processedLines.push(''); // Add separation before new numbered item
            }
            processedLines.push(line);
        } else {
            // This is a continuation line
            // Check if the previous line ended with a sentence-ending punctuation
            const lastLine = processedLines[processedLines.length - 1];
            
            if (lastLine && (lastLine.endsWith('.') || lastLine.endsWith('!') || lastLine.endsWith('?'))) {
                // Previous line ended with sentence-ending punctuation
                // This suggests a natural paragraph break in the PDF
                processedLines.push(''); // Add separation
                processedLines.push(line);
            } else {
                // This is a continuation of the previous line
                if (processedLines.length > 0) {
                    processedLines[processedLines.length - 1] += ' ' + line;
                } else {
                    processedLines.push(line);
                }
            }
        }
    }
    
    // Join with double newlines and clean up
    const result = processedLines
        .filter(line => line !== undefined && line !== null)
        .join('\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
        
    return result;
}

/**
 * Extract background from PDF using the browser session
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {string} pdfRelativeUrl - Relative URL to the PDF
 * @returns {Promise<string>} - Extracted background text
 */
function convertToDirectPDFUrl(downloadFileUrl) {
    // Convert DownloadFile to DownloadFileBytes for direct PDF access
    if (downloadFileUrl.includes('DownloadFile') && !downloadFileUrl.includes('DownloadFileBytes')) {
        return downloadFileUrl.replace('DownloadFile', 'DownloadFileBytes');
    }
    return downloadFileUrl;
}

async function extractBackgroundFromPDFWithBrowser(driver, pdfRelativeUrl) {
    try {
        // Convert to direct PDF URL first
        const directPdfUrl = convertToDirectPDFUrl(pdfRelativeUrl);
        
        // Navigate to the PDF URL to trigger download
        const fullPdfUrl = directPdfUrl.startsWith('http') 
            ? directPdfUrl 
            : 'https://tampagov.hylandcloud.com' + directPdfUrl.replace(/&amp;/g, '&');
        
        // Get current cookies from the browser
        const cookies = await driver.manage().getCookies();
        
        // Create cookie string for axios
        const cookieString = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
        
        // Try to download with browser session
        const response = await axios.get(fullPdfUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
                'User-Agent': await driver.executeScript('return navigator.userAgent'),
                'Cookie': cookieString,
                'Referer': await driver.getCurrentUrl()
            }
        });
        
        // Check if this is actually a PDF
        const pdfHeader = Buffer.from(response.data.slice(0, 10)).toString('ascii');
        if (!pdfHeader.startsWith('%PDF')) {
            return '';
        }
        
        // Parse the PDF
        const pdfData = await pdfParse(response.data);
        const text = pdfData.text;
        
        // Look for background section with improved patterns
        const backgroundPatterns = [
            // Main background pattern - captures until common section headers
            /background\s*:?\s*([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff\s+recommendation|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|contact|prepared\s+by|reviewed\s+by|\n\s*\n|$))/i,
            // Background information variant
            /background\s*information\s*:?\s*([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff\s+recommendation|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|contact|prepared\s+by|reviewed\s+by|\n\s*\n|$))/i,
            // Project background variant
            /project\s*background\s*:?\s*([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff\s+recommendation|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|contact|prepared\s+by|reviewed\s+by|\n\s*\n|$))/i,
            // Business case variant
            /business\s*case\s*:?\s*([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff\s+recommendation|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|contact|prepared\s+by|reviewed\s+by|\n\s*\n|$))/i,
            // Fallback: capture large text blocks that might be background
            /^([\s\S]{200,}?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff\s+recommendation|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|contact|prepared\s+by|reviewed\s+by))/mi
        ];
        
        for (const pattern of backgroundPatterns) {
            const match = text.match(pattern);
            if (match && match[1]) {
                let background = match[1].trim()
                    .replace(/[\f\r]/g, '') // Remove form feeds and carriage returns
                    .replace(/\s*\n\s*/g, '\n') // Normalize line breaks
                    .trim();
                
                // Format numbered lists properly
                background = formatBackgroundText(background);
                
                if (background.length > 20) {
                    return background;
                }
            }
        }
        
        return '';
        
    } catch (error) {
        console.error(`Error extracting background: ${error.message}`);
        return '';
    }
}

/**
 * Main scraping function
 */
async function scrapeWithSelenium(url, meetingId) {
    let driver = await new Builder().forBrowser('chrome').build();
    try {
        await driver.get(url);
        
        // Wait for the page to fully load and JavaScript to execute
        await new Promise(res => setTimeout(res, 5000)); // Initial wait
        
        // Get the full page source after JavaScript execution
        let pageSource = await driver.getPageSource();
        
        // Load the page source into cheerio
        const $ = cheerio.load(pageSource);
        
        // Extract meeting date from the page
        let meetingDate = '';
        // Look for various possible date selectors
        const dateSelectors = [
            '#lblMeetingDate',
            '.meeting-date',
            '[id*="date"]',
            '[class*="date"]'
        ];
        
        for (const selector of dateSelectors) {
            const dateElement = $(selector);
            if (dateElement.length > 0) {
                meetingDate = dateElement.text().trim();
                if (meetingDate && meetingDate.length > 5) {
                    break;
                }
            }
        }
        
        // If no date found in selectors, try to find it in the page title or text
        if (!meetingDate) {
            const pageTitle = $('title').text();
            const dateMatch = pageTitle.match(/(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2}|[A-Za-z]+ \d{1,2}, \d{4})/);
            if (dateMatch) {
                meetingDate = dateMatch[1];
            }
        }
        
        // Look for agenda items with proper File Numbers (using working selector)
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
            }
        });
        
        if (agendaItems.length === 0) {
            console.error(`No agenda item links found for meeting ${meetingId}`);
            return false;
        }
        
        // Now click each agenda item to get detailed information
        
        let orderedListItems = [];
        let supportingDocs = [];
        
        for (let i = 0; i < agendaItems.length; i++) {
            const item = agendaItems[i];
            
            try {
                
                // Call the loadAgendaItem JavaScript function directly using the extracted ID
                if (item.agendaItemId) {
                    await driver.executeScript(`loadAgendaItem(${item.agendaItemId}, false);`);
                } else {
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
                let summarySheetLink = null;
                
                $itemView('a[href*="DownloadFile"]').each((j, docLink) => {
                    const $docLink = $itemView(docLink);
                    const href = $docLink.attr('href');
                    const title = $docLink.attr('title') || '';
                    const text = $docLink.text().trim();
                    if (href) {
                        // Convert to direct download URL for PDFs
                        const directHref = convertToDirectPDFUrl(href);
                        const docInfo = { href: directHref, title, text, originalHref: href };
                        docLinks.push(docInfo);
                        
                        // Track Summary Sheet for background extraction
                        if (text.toLowerCase().includes('summary sheet') && 
                            text.toLowerCase().includes('cover sheet')) {
                            summarySheetLink = docInfo;
                        }
                    }
                });
                supportingDocs.push(docLinks);
                
                // Try to extract background from Summary Sheet PDF if available
                let backgroundText = '';
                if (summarySheetLink) {
                    try {
                        backgroundText = await extractBackgroundFromPDFWithBrowser(driver, summarySheetLink.href);
                    } catch (err) {
                        console.log(`Could not extract background: ${err.message}`);
                    }
                }
                
                // Store background text for later use
                if (!global.agendaBackgrounds) global.agendaBackgrounds = [];
                global.agendaBackgrounds.push(backgroundText);
                
            } catch (err) {
                console.error(`Error extracting Item Details for agenda item ${i+1}:`, err.message);
                orderedListItems.push(item.fileNumber);
                supportingDocs.push([]);
                
                // Store empty background text for consistency
                if (!global.agendaBackgrounds) global.agendaBackgrounds = [];
                global.agendaBackgrounds.push('');
            }
        }
        
        // Extract meeting date from the first summary sheet PDF
        const meetingDateStr = await extractMeetingDateFromFirstPDF(supportingDocs);
        
        // --- Output logic: append supporting docs if found ---
        let markdownContent = orderedListItems.map((item, index) => {
            let cleanedItem = cleanAgendaContent(item);
            
            // Add background section if available
            if (global.agendaBackgrounds && global.agendaBackgrounds[index] && global.agendaBackgrounds[index].trim()) {
                cleanedItem += `\n\n**Background:**\n${global.agendaBackgrounds[index].trim()}`;
            }
            
            // Add supporting docs as links
            if (supportingDocs[index] && supportingDocs[index].length) {
                cleanedItem += '\n\nSupporting documents:';
                supportingDocs[index].forEach(doc => {
                    const docTitle = toTitleCase(doc.text || doc.title || 'Document');
                    cleanedItem += `\n- [${docTitle}](${doc.href.startsWith('http') ? doc.href : 'https://tampagov.hylandcloud.com' + doc.href.replace(/&amp;/g, '&')})`;
                });
            }
            if (/^\d+\./.test(cleanedItem)) {
                return cleanedItem;
            }
            return `${index + 1}. ${cleanedItem}`;
        }).join('\n\n');
        
        // Add meeting date heading at the beginning if available
        if (meetingDateStr) {
            const formattedDate = formatDateForDisplay(meetingDateStr);
            const heading = `# Tampa City Council Agenda\n\n## ${formattedDate}\n\n`;
            markdownContent = heading + markdownContent;
        }

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

        // Generate WordPress output with background sections if available
        const backgrounds = global.agendaBackgrounds || [];
        if (backgrounds.length > 0) {
            generateWordPressOutput(orderedListItems, supportingDocs, meetingId, url, backgrounds);
        } else {
            generateWordPressOutput(orderedListItems, supportingDocs, meetingId, url);
        }

        // Only write file if content exists
        if (markdownContent.trim()) {
            const outputDir = path.join(__dirname, 'agendas');
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir);
            }
            
            // Create filename with meeting date if available
            let fileName = `agenda_${meetingId}`;
            if (meetingDateStr) {
                // Convert date to YYYY-MM-DD format for filename
                const formattedDate = formatDateForFilename(meetingDateStr);
                if (formattedDate) {
                    fileName = `agenda_${meetingId}_${formattedDate}`;
                }
            }
            
            let outputFileName = path.join(outputDir, `${fileName}.md`);
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
                        // Skip summary meetings
                    } else {
                        meetingIds.add(meetingId);
                    }
                }
            }
        });
        
        // Convert the set to an array
        let uniqueMeetingIds = Array.from(meetingIds);
        
        return uniqueMeetingIds;
    } finally {
        // Quit the driver
        await driver.quit();
    }
}

async function main() {
    // Check if a specific meeting ID was provided as command line argument
    const args = process.argv.slice(2);
    const specificMeetingId = args[0];
    
    if (specificMeetingId) {
        // Process single meeting
        const meetingUrl = `https://tampagov.hylandcloud.com/221agendaonline/Meetings/ViewMeeting?id=${specificMeetingId}&doctype=1`;
        await scrapeWithSelenium(meetingUrl, specificMeetingId);
        return;
    }
    
    // URL of the page to scrape for meeting IDs
    let url = 'https://tampagov.hylandcloud.com/221agendaonline/';
    
    // Get unique meeting IDs
    let uniqueMeetingIds = await scrapeMeetingIds(url);
    
    // Scrape each meeting ID sequentially
    for (let meetingId of uniqueMeetingIds) {
        // Use the correct rendered agenda URL
        let meetingUrl = `https://tampagov.hylandcloud.com/221agendaonline/Meetings/ViewMeeting?id=${meetingId}&doctype=1`;
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
    scrapeWithSelenium,
    extractBackgroundFromPDFWithBrowser,
    extractDollarAmounts,
    formatBackgroundText
};

/**
 * Extract meeting date from the first summary sheet PDF
 * @param {Array} supportingDocs - Array of supporting documents for all items
 * @returns {string} - Meeting date in MM/DD/YYYY format or empty string
 */
async function extractMeetingDateFromFirstPDF(supportingDocs) {
    try {
        // Find the first summary sheet PDF from any agenda item
        for (let i = 0; i < supportingDocs.length; i++) {
            const docs = supportingDocs[i];
            if (docs && docs.length > 0) {
                for (const doc of docs) {
                    if (doc.text && doc.text.toLowerCase().includes('summary sheet') && 
                        doc.href && doc.href.includes('.pdf')) {
                        
                        // Download and parse the PDF
                        const pdfUrl = doc.href.startsWith('http') ? 
                            doc.href : 
                            'https://tampagov.hylandcloud.com' + doc.href.replace(/&amp;/g, '&');
                        
                        const response = await axios.get(pdfUrl, { responseType: 'arraybuffer' });
                        const pdfData = await pdfParse(response.data);
                        
                        // Look for "Requested Meeting Date:" pattern
                        const dateMatch = pdfData.text.match(/Requested Meeting Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
                        if (dateMatch) {
                            return dateMatch[1];
                        }
                        
                        // Alternative patterns if the main one doesn't work
                        const altDateMatch = pdfData.text.match(/Meeting Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
                        if (altDateMatch) {
                            return altDateMatch[1];
                        }
                    }
                }
            }
        }
        
        return '';
        
    } catch (error) {
        console.error('Error extracting meeting date from PDF:', error.message);
        return '';
    }
}

/**
 * Format meeting date for display
 * @param {string} dateStr - Date string in MM/DD/YYYY format
 * @returns {string} - Formatted date string for display
 */
function formatDateForDisplay(dateStr) {
    try {
        if (!dateStr || !dateStr.match(/\d{1,2}\/\d{1,2}\/\d{4}/)) return '';
        
        const [month, day, year] = dateStr.split('/');
        const date = new Date(year, month - 1, day);
        
        const options = { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
        };
        
        return date.toLocaleDateString('en-US', options);
    } catch (error) {
        return dateStr; // Return original if formatting fails
    }
}