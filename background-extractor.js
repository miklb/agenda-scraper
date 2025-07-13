const axios = require('axios');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');

/**
 * Extract background section from a Summary Sheet PDF
 * @param {string} pdfUrl - URL to the Summary Sheet PDF
 * @returns {Promise<string>} - Extracted background text or empty string
 */
async function extractBackgroundFromPDF(pdfUrl) {
    try {
        console.log(`Downloading PDF: ${pdfUrl}`);
        
        // Download the PDF
        const response = await axios.get(pdfUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
            }
        });
        
        console.log(`Downloaded ${response.data.length} bytes`);
        
        // Check if this is actually a PDF by looking at the first few bytes
        const pdfHeader = Buffer.from(response.data.slice(0, 10)).toString('ascii');
        if (!pdfHeader.startsWith('%PDF')) {
            console.log(`Warning: Downloaded content doesn't appear to be a PDF. Header: ${pdfHeader}`);
            // Let's see what we actually got
            const contentPreview = Buffer.from(response.data.slice(0, 200)).toString('utf8');
            console.log(`Content preview: ${contentPreview}`);
            return '';
        }
        
        console.log('Parsing PDF...');
        
        // Parse the PDF
        const pdfData = await pdfParse(response.data);
        const text = pdfData.text;
        
        console.log(`Extracted ${text.length} characters from PDF`);
        if (text.length < 100) {
            console.log(`PDF text: ${text}`);
        }
        
        // Look for background section in various formats
        const backgroundPatterns = [
            // Main background pattern - captures until common section headers
            /background\s*:?\s*([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff\s+recommendation|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|contact|prepared\s+by|reviewed\s+by|\n\s*\n|$))/i,
            // Specific BACKGROUND: to FISCAL IMPACT: pattern  
            /BACKGROUND\s*:\s*([\s\S]*?)(?=\s*FISCAL\s+IMPACT\s*:)/i,
            // Background information variant
            /background\s*information\s*:?\s*([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff\s+recommendation|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|contact|prepared\s+by|reviewed\s+by|\n\s*\n|$))/i,
            // Project background variant
            /project\s*background\s*:?\s*([\s\S]*?)(?=\n\s*(?:fiscal\s+impact|recommendation|analysis|staff\s+recommendation|attachments?|budget|legal|conclusion|next\s+steps|justification|alternatives|contact|prepared\s+by|reviewed\s+by|\n\s*\n|$))/i,
            // Legacy patterns for backward compatibility
            /summary\s*:?\s*([\s\S]*?)(?=\n\s*(?:recommendation|analysis|staff|attachments?|fiscal|budget|legal|conclusion|\n\s*\n|$))/i
        ];
        
        for (const pattern of backgroundPatterns) {
            const match = text.match(pattern);
            if (match && match[1]) {
                let background = match[1].trim();
                
                // Clean up the extracted text
                background = background
                    // Remove excessive whitespace
                    .replace(/\s+/g, ' ')
                    // Remove page breaks and form feeds
                    .replace(/[\f\r]/g, '')
                    // Remove multiple newlines
                    .replace(/\n\s*\n\s*\n/g, '\n\n')
                    // Remove leading/trailing whitespace
                    .trim();
                
                // Only return if we have substantial content (more than 20 characters)
                if (background.length > 20) {
                    console.log(`Extracted background (${background.length} chars): ${background.substring(0, 100)}...`);
                    return background;
                }
            }
        }
        
        console.log('No background section found in PDF');
        return '';
        
    } catch (error) {
        console.error(`Error extracting background from PDF: ${error.message}`);
        return '';
    }
}

/**
 * Process agenda items and extract background information from Summary Sheet PDFs
 * @param {Array} agendaItems - Array of agenda items with supporting documents
 * @returns {Promise<Array>} - Array of background texts (empty string if none found)
 */
async function extractBackgroundsFromAgendaItems(agendaItems) {
    const backgrounds = [];
    
    for (let i = 0; i < agendaItems.length; i++) {
        const item = agendaItems[i];
        console.log(`\nProcessing item ${i + 1}: ${item.fileNumber || item.number || i + 1}`);
        
        // Look for Summary Sheet in supporting documents
        let summarySheetUrl = null;
        
        if (item.supportingDocs && item.supportingDocs.length > 0) {
            const summaryDoc = item.supportingDocs.find(doc => 
                doc.text && doc.text.toLowerCase().includes('summary sheet') && 
                doc.text.toLowerCase().includes('cover sheet')
            );
            
            if (summaryDoc) {
                summarySheetUrl = summaryDoc.href.startsWith('http') 
                    ? summaryDoc.href 
                    : 'https://tampagov.hylandcloud.com' + summaryDoc.href.replace(/&amp;/g, '&');
                
                console.log(`Found Summary Sheet: ${summaryDoc.text}`);
            }
        }
        
        if (summarySheetUrl) {
            const background = await extractBackgroundFromPDF(summarySheetUrl);
            backgrounds.push(background);
        } else {
            console.log('No Summary Sheet found for this item');
            backgrounds.push('');
        }
        
        // Small delay to be respectful to the server
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    return backgrounds;
}

/**
 * Load existing agenda file and extract supporting documents structure
 * @param {string} agendaFilePath - Path to existing agenda markdown file
 * @returns {Array} - Array of agenda items with supporting documents
 */
function parseExistingAgenda(agendaFilePath) {
    const content = fs.readFileSync(agendaFilePath, 'utf8');
    const lines = content.split('\n');
    const agendaItems = [];
    
    let currentItem = null;
    let inSupportingDocs = false;
    
    for (const line of lines) {
        // Stop parsing when we hit the end sections (dollar table, CSV data, etc.)
        if (line.trim().startsWith('---') || 
            line.includes('| Agenda # | Amount |') ||
            line.match(/^[A-Z]+-\d+-\d+:\d+/)) {
            break;
        }
        
        // New agenda item - must start with number followed by period and File No.
        const itemMatch = line.match(/^(\d+)\.\s+File No\.\s+([A-Z\d-]+)\s+(.+)/);
        if (itemMatch) {
            if (currentItem) {
                agendaItems.push(currentItem);
            }
            
            currentItem = {
                number: parseInt(itemMatch[1]),
                fileNumber: itemMatch[2],
                text: `File No. ${itemMatch[2]} ${itemMatch[3]}`,
                supportingDocs: []
            };
            inSupportingDocs = false;
            continue;
        }
        
        // Supporting documents section
        if (line.trim() === 'Supporting documents:') {
            inSupportingDocs = true;
            continue;
        } 
        
        // Supporting document link
        if (inSupportingDocs && line.match(/^- \[(.+?)\]\((.+?)\)/)) {
            const docMatch = line.match(/^- \[(.+?)\]\((.+?)\)/);
            if (docMatch && currentItem) {
                currentItem.supportingDocs.push({
                    text: docMatch[1],
                    href: docMatch[2]
                });
            }
            continue;
        }
        
        // Empty line ends supporting docs section
        if (inSupportingDocs && line.trim() === '') {
            inSupportingDocs = false;
            continue;
        }
        
        // If we're in an item but not in supporting docs, this might be continuation text
        if (currentItem && !inSupportingDocs && line.trim() !== '') {
            // Skip continuation for now - we have the main text
        }
    }
    
    if (currentItem) {
        agendaItems.push(currentItem);
    }
    
    console.log(`Parsed ${agendaItems.length} agenda items:`);
    agendaItems.forEach((item, i) => {
        console.log(`  ${i + 1}. ${item.fileNumber} (${item.supportingDocs.length} docs)`);
    });
    
    return agendaItems;
}

/**
 * Main function to process an existing agenda file and add background information
 */
async function addBackgroundToAgenda(meetingId) {
    const agendaFile = path.join(__dirname, 'agendas', `agenda_${meetingId}.md`);
    
    if (!fs.existsSync(agendaFile)) {
        console.error(`Agenda file not found: ${agendaFile}`);
        return false;
    }
    
    console.log(`Processing agenda file: ${agendaFile}`);
    
    // Parse existing agenda
    const agendaItems = parseExistingAgenda(agendaFile);
    console.log(`Found ${agendaItems.length} agenda items`);
    
    // Extract backgrounds
    const backgrounds = await extractBackgroundsFromAgendaItems(agendaItems);
    
    // Save backgrounds to a JSON file for integration
    const backgroundsFile = path.join(__dirname, 'agendas', `agenda_${meetingId}_backgrounds.json`);
    fs.writeFileSync(backgroundsFile, JSON.stringify(backgrounds, null, 2));
    console.log(`Saved backgrounds to: ${backgroundsFile}`);
    
    // Count successful extractions
    const successfulExtractions = backgrounds.filter(bg => bg.length > 0).length;
    console.log(`Successfully extracted background from ${successfulExtractions}/${agendaItems.length} items`);
    
    return backgrounds;
}

// Export functions
module.exports = {
    extractBackgroundFromPDF,
    extractBackgroundsFromAgendaItems,
    parseExistingAgenda,
    addBackgroundToAgenda
};

// Allow running as standalone script
if (require.main === module) {
    const meetingId = process.argv[2];
    if (!meetingId) {
        console.error('Usage: node background-extractor.js <meetingId>');
        console.error('Example: node background-extractor.js 2572');
        process.exit(1);
    }
    
    addBackgroundToAgenda(meetingId)
        .then((backgrounds) => {
            console.log('\nBackground extraction completed!');
            const successCount = backgrounds.filter(bg => bg.length > 0).length;
            console.log(`Extracted ${successCount} backgrounds out of ${backgrounds.length} items`);
        })
        .catch((error) => {
            console.error('Error:', error);
            process.exit(1);
        });
}
