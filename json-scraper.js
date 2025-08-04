const { Builder, By, until } = require('selenium-webdriver');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const { toTitleCase } = require('./format-helpers');

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
 * Convert relative URL to direct PDF URL for downloading
 * @param {string} downloadFileUrl - Original download file URL
 * @returns {string} - Direct PDF URL
 */
function convertToDirectPDFUrl(downloadFileUrl) {
    // Convert DownloadFile to DownloadFileBytes for direct PDF access
    if (downloadFileUrl.includes('DownloadFile') && !downloadFileUrl.includes('DownloadFileBytes')) {
        return downloadFileUrl.replace('DownloadFile', 'DownloadFileBytes');
    }
    return downloadFileUrl;
}

/**
 * Extract background from PDF using the browser session
 * @param {WebDriver} driver - Selenium WebDriver instance
 * @param {string} pdfRelativeUrl - Relative URL to the PDF
 * @returns {Promise<string>} - Extracted background text
 */
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
 * Clean agenda content by removing redundant text
 * @param {string} content - The original agenda content
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
 * Extract meeting date from the first summary sheet PDF
 * @param {Array} supportingDocs - Array of supporting documents for all items
 * @returns {Promise<string>} - Meeting date in MM/DD/YYYY format or empty string
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
 * Extract dollar amounts from agenda items text
 * @param {string} text - Agenda item text
 * @returns {Array<string>} - Array of dollar amounts found
 */
function extractDollarAmounts(text) {
    const dollarRegex = /\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g;
    return text.match(dollarRegex) || [];
}

/**
 * Extract file number from agenda item text
 * @param {string} text - Agenda item text
 * @returns {string|null} - Extracted file number or null if not found
 */
function extractFileNumber(text) {
    // Pattern 1: Standard "File No. XXXX" format
    const fileNoMatch = text.match(/File No\. ([A-Z\/\d-]+)/i);
    if (fileNoMatch) {
        return fileNoMatch[1];
    }
    
    // Pattern 2: Direct file number pattern (for items without "File No." prefix)
    // Matches patterns like CM25-13759, E2025-15, PS25-15649, etc.
    const directFileMatch = text.match(/^([A-Z]{1,5}\d{2,4}-\d{4,6}(?:-[A-Z])?)/i);
    if (directFileMatch) {
        return directFileMatch[1];
    }
    
    // Pattern 3: Special cases
    if (text.trim() === 'Administration Update') {
        return null; // This item genuinely has no file number
    }
    
    return null;
}

/**
 * Main scraping function
 * @param {string} url - URL to scrape
 * @param {string} meetingId - Meeting ID
 * @returns {Promise<boolean>} - Success status
 */
async function scrapeWithSelenium(url, meetingId, meetingType = 'regular') {
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
        
        // Look specifically for links that are actual agenda items
        $('a[id^="lnk"]').each((i, link) => {
            const $link = $(link);
            const text = $link.text().trim();
            const href = $link.attr('href');
            const id = $link.attr('id');
            
            // Function to determine if this is an agenda item link
            function isAgendaItemLink(text) {
                // Skip if text is too short or empty
                if (!text || text.length < 5) return false;
                
                // Include if it starts with "File No."
                if (text.startsWith('File No.')) return true;
                
                // Include if it matches a direct file number pattern
                if (text.match(/^[A-Z]{1,5}\d{2,4}-\d{4,6}/i)) return true;
                
                // Include special cases
                if (text.trim() === 'Administration Update') return true;
                
                // Exclude obvious non-agenda items
                const excludePatterns = [
                    /^download/i,
                    /^view/i,
                    /^\s*$/,
                    /^print/i,
                    /^email/i
                ];
                
                for (const pattern of excludePatterns) {
                    if (pattern.test(text)) return false;
                }
                
                return false;
            }
            
            // Only include items that are actual agenda items
            if (isAgendaItemLink(text)) {
                // Initialize with null agenda item ID
                let agendaItemId = null;
                
                // Extract the agenda item ID from the JavaScript href (old method)
                const agendaItemIdMatch = href && href.match(/loadAgendaItem\((\d+),/);
                if (agendaItemIdMatch) {
                    agendaItemId = agendaItemIdMatch[1];
                }
                
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

        // Try to find item IDs by scanning the document for supporting document links that contain itemId parameters
        const supportingDocLinks = $('a[href*="DownloadFile"]');
                const itemIdMap = {};
        
        // Group supporting document links by their itemId
        const itemIdToFileNumbers = {};
        
        supportingDocLinks.each((index, link) => {
            const href = $(link).attr('href');
            if (href) {
                const itemIdMatch = href.match(/itemId=(\d+)/);
                if (itemIdMatch && itemIdMatch[1]) {
                    const itemId = itemIdMatch[1];
                    const text = $(link).text().trim();
                    
                    // Collect all document texts for this itemId
                    if (!itemIdToFileNumbers[itemId]) {
                        itemIdToFileNumbers[itemId] = [];
                    }
                    itemIdToFileNumbers[itemId].push(text);
                    
                    // Also try to extract file number from URL patterns
                    const fileNumberMatch = href.match(/File_([A-Za-z0-9-_]+)\.pdf/i) || 
                                           href.match(/\/([A-Za-z0-9-_]+)_\d+_/i);
                    
                    if (fileNumberMatch && fileNumberMatch[1]) {
                        let fileNumberPart = fileNumberMatch[1].replace(/_/g, '/');
                        // Map the item ID to the file number for later matching
                        itemIdMap[fileNumberPart.toUpperCase()] = itemId;
                    }
                }
            }
        });        // Update agenda items with the extracted item IDs
        for (let item of agendaItems) {
            if (!item.agendaItemId) {
                // Extract the file number (after "File No. ")
                const fileNumberPart = item.fileNumber.substring(9).trim().toUpperCase();
                
                // Method 1: Direct matching using file number extracted from URLs
                for (const [key, id] of Object.entries(itemIdMap)) {
                    if (fileNumberPart.includes(key) || key.includes(fileNumberPart)) {
                        item.agendaItemId = id;
                        break;
                    }
                }
                
                // Method 2: If still no match, try using the collected document texts
                if (!item.agendaItemId) {
                    for (const [itemId, texts] of Object.entries(itemIdToFileNumbers)) {
                        // Check if any of the texts contain the file number
                        const matchingText = texts.find(text => {
                            return text.toUpperCase().includes(fileNumberPart) || 
                                  fileNumberPart.includes(text.toUpperCase());
                        });
                        
                        if (matchingText) {
                            item.agendaItemId = itemId;
                            break;
                        }
                    }
                }
                
                // If we're still unable to find the ID, use a more aggressive matching approach
                if (!item.agendaItemId) {
                    // Convert File No. AB2-25-04 to just AB2-25-04 or ab2-25-04
                    const cleanFileNumber = fileNumberPart.replace(/[^A-Za-z0-9-]/g, '');
                    
                    for (const [itemId, texts] of Object.entries(itemIdToFileNumbers)) {
                        for (const text of texts) {
                            const cleanText = text.toUpperCase().replace(/[^A-Za-z0-9-]/g, '');
                            if (cleanText.includes(cleanFileNumber) || cleanFileNumber.includes(cleanText)) {
                                item.agendaItemId = itemId;
                                break;
                            }
                        }
                        if (item.agendaItemId) break;
                    }
                }
            }
        }
        
        // Log the extracted item IDs for debugging
        console.log('Extracted agenda item IDs:');
        for (const item of agendaItems) {
            console.log(`File No. ${item.fileNumber}: Item ID = ${item.agendaItemId || 'Not found'}`);
        }
        
        // Now click each agenda item to get detailed information
        let processedItems = [];
        
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
                
                // Extract the full description
                const fullDescription = $itemView('.item-view-title-text').text().trim();
                const finalItemText = fullDescription || item.fileNumber;
                
                // Add logging to verify correct content extraction
                console.log(`Item ${i + 1} (ID: ${item.agendaItemId}): Extracted ${finalItemText.substring(0, 100)}...`);
                
                // Update the agendaItemId from the document URLs if we didn't have it before
                if (!item.agendaItemId) {
                    $itemView('a[href*="DownloadFile"]').each((j, docLink) => {
                        const $docLink = $itemView(docLink);
                        const href = $docLink.attr('href');
                        if (href) {
                            const itemIdMatch = href.match(/itemId=(\d+)/);
                            if (itemIdMatch && itemIdMatch[1]) {
                                item.agendaItemId = itemIdMatch[1];
                                console.log(`Found item ID ${item.agendaItemId} from supporting document link for ${item.fileNumber}`);
                                return false; // Break the loop after finding first match
                            }
                        }
                    });
                }
                
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
                        // Create absolute URL
                        const fullUrl = directHref.startsWith('http') ? 
                            directHref : 
                            'https://tampagov.hylandcloud.com' + directHref.replace(/&amp;/g, '&');
                        
                        const docInfo = { 
                            title: toTitleCase(text || title || 'Document'),
                            url: fullUrl,
                            originalText: text,
                            originalTitle: title
                        };
                        docLinks.push(docInfo);
                        
                        // Track Summary Sheet for background extraction
                        if (text.toLowerCase().includes('summary sheet') && 
                            text.toLowerCase().includes('cover sheet')) {
                            summarySheetLink = docInfo;
                        }
                    }
                });
                
                // Try to extract background from Summary Sheet PDF if available
                let backgroundText = '';
                if (summarySheetLink) {
                    try {
                        backgroundText = await extractBackgroundFromPDFWithBrowser(driver, summarySheetLink.url);
                    } catch (err) {
                        console.log(`Could not extract background: ${err.message}`);
                    }
                }
                
                // Clean the agenda item content
                const cleanedContent = cleanAgendaContent(finalItemText);
                
                // Extract dollar amounts
                const dollarAmounts = extractDollarAmounts(finalItemText);
                
                // Extract file number
                const fileNo = extractFileNumber(finalItemText);
                
                // Extract item ID from supporting document URLs if not already set
                let finalAgendaItemId = item.agendaItemId;
                if (!finalAgendaItemId && docLinks.length > 0) {
                    for (const doc of docLinks) {
                        const itemIdMatch = doc.url.match(/itemId=(\d+)/);
                        if (itemIdMatch && itemIdMatch[1]) {
                            finalAgendaItemId = itemIdMatch[1];
                            console.log(`Found item ID ${finalAgendaItemId} from supporting document URL for ${fileNo}`);
                            break;
                        }
                    }
                }
                
                // Create a structured object for this item
                const itemObject = {
                    number: i + 1,
                    agendaItemId: finalAgendaItemId,
                    fileNumber: fileNo,
                    title: cleanedContent,
                    rawTitle: finalItemText,
                    background: backgroundText,
                    supportingDocuments: docLinks,
                    dollarAmounts: dollarAmounts
                };
                
                processedItems.push(itemObject);
                
            } catch (err) {
                console.error(`Error extracting Item Details for agenda item ${i+1}:`, err.message);
                
                // Create a basic object with just the file number information
                processedItems.push({
                    number: i + 1,
                    agendaItemId: item.agendaItemId, // Keep original ID if available
                    fileNumber: item.fileNumber.replace('File No. ', ''),
                    title: item.fileNumber,
                    rawTitle: item.fileNumber,
                    background: '',
                    supportingDocuments: [],
                    dollarAmounts: []
                });
            }
        }
        
        // Extract meeting date - try HTML first, then fall back to PDF
        let meetingDateStr = meetingDate; // Use the date extracted from HTML
        console.log(`\n=== Meeting Date Extraction ===`);
        console.log(`HTML extracted date: "${meetingDate}"`);
        
        // If no date found in HTML, try PDF extraction as fallback
        if (!meetingDateStr) {
            console.log('No date found in HTML, trying PDF extraction...');
            // Create array of supporting docs for each item
            const supportingDocs = processedItems.map(item => 
                item.supportingDocuments.map(doc => ({
                    text: doc.originalText,
                    href: doc.url
                }))
            );
            meetingDateStr = await extractMeetingDateFromFirstPDF(supportingDocs);
            console.log(`PDF extracted date: "${meetingDateStr}"`);
        }
        
        // Create structured JSON object
        const meetingData = {
            meetingId: meetingId,
            meetingType: meetingType, // Use the provided meeting type from the main page
            meetingDate: meetingDateStr,
            formattedDate: formatDateForFilename(meetingDateStr),
            sourceUrl: url,
            agendaItems: processedItems
        };
        
        // Calculate dollar amount totals
        if (meetingData.agendaItems.some(item => item.dollarAmounts.length > 0)) {
            let totalAmount = 0;
            meetingData.agendaItems.forEach(item => {
                item.dollarAmounts.forEach(amount => {
                    const numericValue = parseFloat(amount.replace(/[$,]/g, ''));
                    totalAmount += numericValue;
                });
            });
            meetingData.totalDollarAmount = totalAmount;
            meetingData.formattedTotalDollarAmount = `$${totalAmount.toLocaleString()}`;
        }
        
        // Save the JSON data
        const outputDir = path.join(__dirname, 'data');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }
        
        // Create filename with meeting date if available
        let fileName = `meeting_${meetingId}`;
        if (meetingData.formattedDate) {
            fileName = `meeting_${meetingId}_${meetingData.formattedDate}`;
        }
        
        const outputFileName = path.join(outputDir, `${fileName}.json`);
        fs.writeFileSync(outputFileName, JSON.stringify(meetingData, null, 2));
        
        console.log(`Successfully created JSON: ${outputFileName}`);
        
        return true;
    } catch (error) {
        console.error(`Error scraping meeting ${meetingId}:`, error);
        return false;
    } finally {
        await driver.quit();
    }
}

/**
 * Detect meeting type (regular, evening, special, etc.)
 * @param {CheerioAPI} $ - Cheerio instance loaded with page HTML
 * @returns {string} - Meeting type
 */
function detectMeetingType($) {
    // Find the CITY OF TAMPA h1
    const cityTampaH1 = $('h1').filter(function() {
        return $(this).text().trim() === 'CITY OF TAMPA';
    });
    
    // Default meeting type if structure not found
    let meetingType = 'regular';
    
    if (cityTampaH1.length > 0) {
        // Get the next h1 element
        const nextH1 = cityTampaH1.next('h1');
        if (nextH1.length > 0) {
            // Use the exact text content as the meeting type
            const rawText = nextH1.text().trim();
            if (rawText) {
                meetingType = rawText;
            }
        }
    }
    
    return meetingType;
}

/**
 * Scrape meeting IDs and types from the main page
 * @param {string} url - URL of the main page
 * @returns {Promise<Array<Object>>} - Array of meeting objects with ID and type
 */
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
        let meetingData = [];
        $('#meetings-list-upcoming table:first-of-type tr').each((i, tr) => {
            let $tr = $(tr);
            let lastTd = $tr.find('td').last();
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
                let meetingId = $tr.attr('data-meeting-id');
                if (meetingId) {
                    // Explicitly exclude known summary meeting IDs
                    if (meetingId === '2651') {
                        // Skip summary meetings
                    } else {
                        // Extract the meeting type from the mtgType column
                        let meetingType = 'regular'; // Default value
                        
                        // Find the cell with data-sortable-type="mtgType"
                        const mtgTypeCell = $tr.find('td[data-sortable-type="mtgType"]');
                        if (mtgTypeCell.length > 0) {
                            meetingType = mtgTypeCell.text().trim();
                        }
                        
                        // Add the meeting data to our collection
                        meetingData.push({
                            id: meetingId,
                            type: meetingType
                        });
                    }
                }
            }
        });
        
        return meetingData;
    } finally {
        // Quit the driver
        await driver.quit();
    }
}

/**
 * Main function
 */
async function main() {
    // Check if a specific meeting ID was provided as command line argument
    const args = process.argv.slice(2);
    const specificMeetingId = args[0];
    
    // URL of the page to scrape for meeting IDs
    let url = 'https://tampagov.hylandcloud.com/221agendaonline/';
    
    if (specificMeetingId) {
        // For specific meeting ID, we still need to get its meeting type from the main page
        const meetingData = await scrapeMeetingIds(url);
        const meetingInfo = meetingData.find(meeting => meeting.id === specificMeetingId);
        const meetingType = meetingInfo ? meetingInfo.type : 'regular';
        
        // Process single meeting with its type
        const meetingUrl = `https://tampagov.hylandcloud.com/221agendaonline/Meetings/ViewMeeting?id=${specificMeetingId}&doctype=1`;
        await scrapeWithSelenium(meetingUrl, specificMeetingId, meetingType);
        return;
    }
    
    // Get meetings with their IDs and types
    let meetingsData = await scrapeMeetingIds(url);
    
    // Scrape each meeting ID sequentially
    for (let meeting of meetingsData) {
        // Use the correct rendered agenda URL
        let meetingUrl = `https://tampagov.hylandcloud.com/221agendaonline/Meetings/ViewMeeting?id=${meeting.id}&doctype=1`;
        await scrapeWithSelenium(meetingUrl, meeting.id, meeting.type);
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
    formatBackgroundText,
    cleanAgendaContent
};
