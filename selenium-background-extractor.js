const { Builder, By, until } = require('selenium-webdriver');
const fs = require('fs');
const path = require('path');

/**
 * Extract backgrounds from Summary Sheet PDFs using browser automation
 * This script opens each PDF in the browser and attempts to extract text
 */
async function extractBackgroundsWithSelenium(meetingId) {
    // Read the existing agenda file to get PDF links
    const agendaFile = path.join(__dirname, 'agendas', `agenda_${meetingId}.md`);
    if (!fs.existsSync(agendaFile)) {
        console.error(`Agenda file not found: ${agendaFile}`);
        return;
    }
    
    const content = fs.readFileSync(agendaFile, 'utf8');
    const summarySheetLinks = [];
    
    // Extract Summary Sheet links from the agenda file
    const lines = content.split('\n');
    let currentItemNumber = 0;
    
    for (const line of lines) {
        // Track agenda item numbers
        const itemMatch = line.match(/^(\d+)\.\s+File No\./);
        if (itemMatch) {
            currentItemNumber = parseInt(itemMatch[1]);
        }
        
        // Find Summary Sheet links
        const linkMatch = line.match(/- \[Summary Sheet- COVER SHEET\]\(([^)]+)\)/);
        if (linkMatch && currentItemNumber > 0) {
            summarySheetLinks.push({
                itemNumber: currentItemNumber,
                url: linkMatch[1]
            });
        }
    }
    
    console.log(`Found ${summarySheetLinks.length} Summary Sheet links`);
    
    if (summarySheetLinks.length === 0) {
        console.log('No Summary Sheet links found');
        return;
    }
    
    // Initialize browser
    let driver = await new Builder().forBrowser('chrome').build();
    const backgrounds = {};
    
    try {
        // First, navigate to the main agenda page to establish session
        const agendaUrl = `https://tampagov.hylandcloud.com/221agendaonline/Meetings/ViewMeeting?id=${meetingId}&doctype=1`;
        console.log('Establishing session...');
        await driver.get(agendaUrl);
        await new Promise(res => setTimeout(res, 3000));
        
        // Process each Summary Sheet link
        for (let i = 0; i < Math.min(summarySheetLinks.length, 5); i++) { // Limit to first 5 for testing
            const link = summarySheetLinks[i];
            
            try {
                console.log(`\nProcessing item ${link.itemNumber}: ${link.url}`);
                
                // Navigate to the PDF
                await driver.get(link.url);
                await new Promise(res => setTimeout(res, 3000));
                
                // Try to get page text (this works if the PDF renders as text in browser)
                try {
                    const pageText = await driver.findElement(By.tagName('body')).getText();
                    
                    if (pageText && pageText.length > 100) {
                        console.log(`Extracted ${pageText.length} characters`);
                        
                        // Look for background section
                        const backgroundMatch = pageText.match(/background[:\s]*(.*?)(?=recommendation|analysis|staff|fiscal|$)/is);
                        if (backgroundMatch && backgroundMatch[1]) {
                            const background = backgroundMatch[1].trim().substring(0, 500); // Limit length
                            console.log(`Found background: ${background.substring(0, 100)}...`);
                            backgrounds[link.itemNumber] = background;
                        } else {
                            console.log('No background section found');
                        }
                    } else {
                        console.log('PDF did not render as text in browser');
                    }
                } catch (err) {
                    console.log(`Could not extract text: ${err.message}`);
                }
                
            } catch (err) {
                console.error(`Error processing item ${link.itemNumber}: ${err.message}`);
            }
            
            // Small delay between requests
            await new Promise(res => setTimeout(res, 2000));
        }
        
    } finally {
        await driver.quit();
    }
    
    // Save the extracted backgrounds
    const backgroundsFile = path.join(__dirname, 'agendas', `agenda_${meetingId}_backgrounds.json`);
    fs.writeFileSync(backgroundsFile, JSON.stringify(backgrounds, null, 2));
    
    const extractedCount = Object.keys(backgrounds).length;
    console.log(`\nExtracted ${extractedCount} backgrounds and saved to ${backgroundsFile}`);
    
    return backgrounds;
}

/**
 * Update the WordPress HTML file to include background information
 */
async function updateWordPressWithBackgrounds(meetingId) {
    const backgroundsFile = path.join(__dirname, 'agendas', `agenda_${meetingId}_backgrounds.json`);
    const wpFile = path.join(__dirname, 'agendas', `agenda_${meetingId}.wp.html`);
    
    if (!fs.existsSync(backgroundsFile) || !fs.existsSync(wpFile)) {
        console.error('Background or WordPress file not found');
        return;
    }
    
    const backgrounds = JSON.parse(fs.readFileSync(backgroundsFile, 'utf8'));
    let wpContent = fs.readFileSync(wpFile, 'utf8');
    
    // Add backgrounds to WordPress content
    // This is a simplified approach - in practice, you'd want more sophisticated HTML parsing
    for (const [itemNumber, background] of Object.entries(backgrounds)) {
        const detailsBlock = `\n<details class="wp-block-details">
<summary>Background</summary>
<!-- wp:paragraph -->
<p>${background}</p>
<!-- /wp:paragraph -->
</details>`;
        
        // Find the list item and add background after it
        const listItemPattern = new RegExp(`<li>([^<]*File No\\.[^<]*${itemNumber}[^<]*)</li>`, 'i');
        wpContent = wpContent.replace(listItemPattern, `<li>$1${detailsBlock}</li>`);
    }
    
    // Save updated WordPress file
    const updatedWpFile = path.join(__dirname, 'agendas', `agenda_${meetingId}_with_backgrounds.wp.html`);
    fs.writeFileSync(updatedWpFile, wpContent);
    console.log(`Updated WordPress file saved as: ${updatedWpFile}`);
}

// Export functions
module.exports = {
    extractBackgroundsWithSelenium,
    updateWordPressWithBackgrounds
};

// Allow running as standalone script
if (require.main === module) {
    const meetingId = process.argv[2];
    if (!meetingId) {
        console.error('Usage: node selenium-background-extractor.js <meetingId>');
        console.error('Example: node selenium-background-extractor.js 2572');
        process.exit(1);
    }
    
    extractBackgroundsWithSelenium(meetingId)
        .then((backgrounds) => {
            console.log('\nBackground extraction completed!');
            return updateWordPressWithBackgrounds(meetingId);
        })
        .then(() => {
            console.log('WordPress file updated with backgrounds!');
        })
        .catch((error) => {
            console.error('Error:', error);
            process.exit(1);
        });
}
