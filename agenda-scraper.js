const { Builder, By, until } = require('selenium-webdriver');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const { generateWordPressOutput, cleanAgendaContent } = require('./wordpress-functions');
const { toTitleCase } = require('./format-helpers');

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
            
        console.log(`Navigating to PDF: ${fullPdfUrl}`);
        
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
        
        console.log(`Downloaded ${response.data.length} bytes`);
        
        // Check if this is actually a PDF
        const pdfHeader = Buffer.from(response.data.slice(0, 10)).toString('ascii');
        if (!pdfHeader.startsWith('%PDF')) {
            console.log(`Warning: Not a PDF. Header: ${pdfHeader}`);
            return '';
        }
        
        // Parse the PDF
        const pdfData = await pdfParse(response.data);
        const text = pdfData.text;
        
        console.log(`Extracted ${text.length} characters from PDF`);
        
        // Look for background section
        const backgroundPatterns = [
            /background\s*:?\s*([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|\n\s*\n|$))/i,
            /background\s*information\s*:?\s*([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|\n\s*\n|$))/i,
            /project\s*background\s*:?\s*([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|\n\s*\n|$))/i
        ];
        
        for (const pattern of backgroundPatterns) {
            const match = text.match(pattern);
            if (match && match[1]) {
                let background = match[1].trim()
                    .replace(/\s+/g, ' ')
                    .replace(/[\f\r]/g, '')
                    .trim();
                
                if (background.length > 20) {
                    console.log(`Found background (${background.length} chars): ${background.substring(0, 100)}...`);
                    return background;
                }
            }
        }
        
        console.log('No background section found');
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
                        console.log(`Attempting to extract background from: ${summarySheetLink.text}`);
                        console.log(`PDF URL: ${summarySheetLink.href}`);
                        backgroundText = await extractBackgroundFromPDFWithBrowser(driver, summarySheetLink.href);
                        console.log(`Background extraction result: ${backgroundText.length} characters`);
                        if (backgroundText.length > 0) {
                            console.log(`Background preview: ${backgroundText.substring(0, 100)}...`);
                        }
                    } catch (err) {
                        console.log(`Could not extract background: ${err.message}`);
                    }
                } else {
                    console.log('No Summary Sheet found for background extraction');
                }
                
                // Store background text for later use
                if (!global.agendaBackgrounds) global.agendaBackgrounds = [];
                global.agendaBackgrounds.push(backgroundText);
                console.log(`Stored background for item ${i + 1}: ${backgroundText.length} chars`);
                
            } catch (err) {
                console.error(`Error extracting Item Details for agenda item ${i+1}:`, err.message);
                orderedListItems.push(item.fileNumber);
                supportingDocs.push([]);
                
                // Store empty background text for consistency
                if (!global.agendaBackgrounds) global.agendaBackgrounds = [];
                global.agendaBackgrounds.push('');
            }
        }
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
            console.log(`Generating WordPress output with ${backgrounds.filter(bg => bg.length > 0).length} background sections`);
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
    scrapeWithSelenium,
    extractBackgroundFromPDFWithBrowser
};