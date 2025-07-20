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
        
        // Look for background section with specific patterns only
        const backgroundPatterns = [
            // Main background pattern - captures until common section headers
            /background\s*:?\s*([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff\s+recommendation|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|contact|prepared\s+by|reviewed\s+by|\n\s*\n|$))/i,
            // Background information variant
            /background\s*information\s*:?\s*([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff\s+recommendation|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|contact|prepared\s+by|reviewed\s+by|\n\s*\n|$))/i,
            // Project background variant
            /project\s*background\s*:?\s*([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff\s+recommendation|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|contact|prepared\s+by|reviewed\s+by|\n\s*\n|$))/i,
            // Business case variant
            /business\s*case\s*:?\s*([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff\s+recommendation|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|contact|prepared\s+by|reviewed\s+by|\n\s*\n|$))/i
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
        
        // Look for date in h1 elements (for evening agendas)
        if (!meetingDate) {
            $('h1').each((i, el) => {
                const text = $(el).text().trim();
                // Look for patterns like "Thursday, July 24, 2025"
                const dateMatch = text.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
                if (dateMatch) {
                    meetingDate = dateMatch[1];
                    return false; // break out of each loop
                }
                // Also look for MM/DD/YYYY patterns
                const numericDateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
                if (numericDateMatch) {
                    meetingDate = numericDateMatch[1];
                    return false;
                }
            });
        }
        
        // Look for date in span elements as fallback
        if (!meetingDate) {
            $('span').each((i, el) => {
                const text = $(el).text().trim();
                // Look for patterns like "Thursday, July 24, 2025"
                const dateMatch = text.match(/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
                if (dateMatch) {
                    meetingDate = dateMatch[1];
                    return false; // break out of each loop
                }
            });
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
        let agendaItemIds = [];
        
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
                
                // Add a delay to ensure the content fully loads before checking
                await new Promise(res => setTimeout(res, 2000));
                
                // Wait for content to actually load and be specific to this item
                // For items with the same file number, we need to be more specific
                const expectedFileNumber = item.fileNumber.match(/File No\. ([A-Z\d-]+)/);
                const expectedFileNo = expectedFileNumber ? expectedFileNumber[1] : '';
                
                await driver.wait(async () => {
                    const itemViewHtml = await driver.findElement(By.css('#itemView')).getAttribute('innerHTML');
                    
                    // Basic content validation
                    if (!itemViewHtml || itemViewHtml.trim().length < 100 || !itemViewHtml.includes('item-view-title-text')) {
                        return false;
                    }
                    
                    // If we have an agendaItemId, ensure the content is for this specific item
                    if (item.agendaItemId) {
                        // Check for this specific itemId in document links (most reliable)
                        const itemIdPattern = new RegExp(`[?&]itemId=${item.agendaItemId}[&\#]`);
                        if (itemViewHtml.match(itemIdPattern)) {
                            return true;
                        }
                        
                        // Also check for itemId without trailing characters for end-of-url cases
                        const itemIdPatternEnd = new RegExp(`[?&]itemId=${item.agendaItemId}$`);
                        if (itemViewHtml.match(itemIdPatternEnd)) {
                            return true;
                        }
                        
                        // Also check for itemId in various other contexts
                        if (itemViewHtml.includes(`itemId=${item.agendaItemId}&`) || 
                            itemViewHtml.includes(`itemId=${item.agendaItemId}"`)) {
                            return true;
                        }
                    }
                    
                    // Fallback for file number matching (less reliable for duplicate file numbers)
                    return expectedFileNo === '' || itemViewHtml.includes(expectedFileNo);
                }, 20000); // Increased timeout for more reliable loading
                
                // Get the populated content
                const itemViewHtml = await driver.findElement(By.css('#itemView')).getAttribute('innerHTML');
                const $itemView = cheerio.load(itemViewHtml);
                
                // Validate that we have the right content by checking document itemIds
                if (item.agendaItemId) {
                    const hasCorrectItemId = itemViewHtml.includes(`itemId=${item.agendaItemId}`);
                    if (!hasCorrectItemId) {
                        console.warn(`Warning: Item ${i + 1} (ID: ${item.agendaItemId}) may have loaded incorrect content`);
                        // Try clicking again and waiting longer
                        await driver.executeScript(`loadAgendaItem(${item.agendaItemId}, false);`);
                        await new Promise(res => setTimeout(res, 3000));
                        const retryHtml = await driver.findElement(By.css('#itemView')).getAttribute('innerHTML');
                        const $retryView = cheerio.load(retryHtml);
                        if (retryHtml.includes(`itemId=${item.agendaItemId}`)) {
                            console.log(`Retry successful for item ${i + 1}`);
                            // Use the retry content
                            const retryDescription = $retryView('.item-view-title-text').text().trim();
                            const retryItemText = retryDescription || item.fileNumber;
                            console.log(`Item ${i + 1} (ID: ${item.agendaItemId}): Extracted ${retryItemText.substring(0, 100)}...`);
                            orderedListItems.push(retryItemText);
                            
                            // Re-extract documents with retry content
                            const retryDocLinks = [];
                            let retrySummarySheetLink = null;
                            $retryView('a[href*="DownloadFile"]').each((j, docLink) => {
                                const $docLink = $retryView(docLink);
                                const href = $docLink.attr('href');
                                const title = $docLink.attr('title') || '';
                                const text = $docLink.text().trim();
                                if (href) {
                                    const directHref = convertToDirectPDFUrl(href);
                                    const docInfo = { href: directHref, title, text, originalHref: href };
                                    retryDocLinks.push(docInfo);
                                    
                                    if (text.toLowerCase().includes('summary sheet') && 
                                        text.toLowerCase().includes('cover sheet')) {
                                        retrySummarySheetLink = docInfo;
                                    }
                                }
                            });
                            supportingDocs.push(retryDocLinks);
                            
                            // Extract background for retry
                            let retryBackgroundText = '';
                            if (retrySummarySheetLink) {
                                try {
                                    retryBackgroundText = await extractBackgroundFromPDFWithBrowser(driver, retrySummarySheetLink.href);
                                } catch (err) {
                                    console.log(`Could not extract background: ${err.message}`);
                                }
                            }
                            if (!global.agendaBackgrounds) global.agendaBackgrounds = [];
                            global.agendaBackgrounds.push(retryBackgroundText);
                            
                            continue; // Skip the normal processing
                        }
                    }
                }
                
                // Extract the full description
                const fullDescription = $itemView('.item-view-title-text').text().trim();
                const finalItemText = fullDescription || item.fileNumber;
                
                // Add logging to verify correct content extraction
                console.log(`Item ${i + 1} (ID: ${item.agendaItemId}): Extracted ${finalItemText.substring(0, 100)}...`);
                
                orderedListItems.push(finalItemText);
                agendaItemIds.push(item.agendaItemId); // Collect the agendaItemId
                
                // Extract supporting document links (only if not already processed in retry)
                if (orderedListItems[orderedListItems.length - 1] === finalItemText) {
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
                    
                    // Add logging for document extraction
                    console.log(`Item ${i + 1} found ${docLinks.length} supporting documents`);
                    if (docLinks.length > 0) {
                        console.log(`First document href contains itemId: ${docLinks[0].href.includes('itemId=')}`);
                    }
                    
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
                }
                
            } catch (err) {
                console.error(`Error extracting Item Details for agenda item ${i+1}:`, err.message);
                orderedListItems.push(item.fileNumber);
                supportingDocs.push([]);
                
                // Store empty background text for consistency
                if (!global.agendaBackgrounds) global.agendaBackgrounds = [];
                global.agendaBackgrounds.push('');
            }
        }
        
        // Extract meeting date - try HTML first, then fall back to PDF
        let meetingDateStr = meetingDate; // Use the date extracted from HTML
        console.log(`\n=== Meeting Date Extraction ===`);
        console.log(`HTML extracted date: "${meetingDate}"`);
        
        // If no date found in HTML, try PDF extraction as fallback
        if (!meetingDateStr) {
            console.log('No date found in HTML, trying PDF extraction...');
            meetingDateStr = await extractMeetingDateFromFirstPDF(supportingDocs);
            console.log(`PDF extracted date: "${meetingDateStr}"`);
        }
        
        // Convert to filename format for debugging
        if (meetingDateStr) {
            const formattedForFile = formatDateForFilename(meetingDateStr);
            console.log(`Final formatted date: "${formattedForFile}"`);
        }
        console.log(`=== End Date Extraction ===\n`);
        
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
        const formattedDateForWP = meetingDateStr ? formatDateForFilename(meetingDateStr) : null;
        if (backgrounds.length > 0) {
            generateWordPressOutput(orderedListItems, supportingDocs, meetingId, url, backgrounds, agendaItemIds, formattedDateForWP);
        } else {
            generateWordPressOutput(orderedListItems, supportingDocs, meetingId, url, [], agendaItemIds, formattedDateForWP);
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
                        
                        console.log(`\n=== PDF Date Extraction Debug ===`);
                        console.log(`PDF URL: ${pdfUrl}`);
                        console.log(`PDF Text preview: ${pdfData.text.substring(0, 500)}...`);
                        
                        // Look for "Requested Meeting Date:" pattern
                        const dateMatch = pdfData.text.match(/Requested Meeting Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
                        if (dateMatch) {
                            console.log(`Found "Requested Meeting Date": ${dateMatch[1]}`);
                            return dateMatch[1];
                        }
                        
                        // Alternative patterns if the main one doesn't work
                        const altDateMatch = pdfData.text.match(/Meeting Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
                        if (altDateMatch) {
                            console.log(`Found "Meeting Date": ${altDateMatch[1]}`);
                            return altDateMatch[1];
                        }
                        
                        // Show all dates found for debugging
                        const allDates = pdfData.text.match(/\d{1,2}\/\d{1,2}\/\d{4}/g);
                        console.log(`All dates found in PDF: ${allDates ? allDates.join(', ') : 'none'}`);
                        console.log(`=== End PDF Debug ===\n`);
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