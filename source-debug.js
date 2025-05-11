const cheerio = require('cheerio');
const fs = require('fs');

async function scrapeFromLocalFile(filePath) {
    // Read the local HTML file
    let pageSource = fs.readFileSync(filePath, 'utf8');
    
    // Load the page source into cheerio
    const $ = cheerio.load(pageSource);
    
    // Initialize an array to hold the ordered list items
    let orderedListItems = [];
    
    // Find all tables with the specified structure
    $('table').each((i, table) => {
        const hasNumberSpan = $(table).find('td > p > span').filter((i, span) => {
            return /^\d+\.$/.test($(span).text().trim());
        }).length > 0;
        
        if (hasNumberSpan) {
            // Extract the table content and combine into a single list item
            let combinedContent = '';
            $(table).find('td').each((i, td) => {
                combinedContent += $(td).text().trim() + ' ';
            });
            orderedListItems.push(combinedContent.trim());
        }
    });
    
    // Pause for debugging
    console.log('Scraping paused for debugging. Ordered list items:', orderedListItems);
    debugger; // You can set a breakpoint here if using a debugger
    
    // Convert the ordered list items to markdown format and strip whitespace, tabs, line breaks, "Original Motion" content, "(To be R/F)", "Continued", and "File No. CRA24-XXXX"
    let markdownContent = orderedListItems.map(item => 
        item.replace(/\s+/g, ' ')
            .replace(/\(Original Motion[^)]*\)/gi, '')
            .replace(/\(To be R\/F\)/gi, '')
            .replace(/\(Continued[^)]*\)/gi, '')
            .replace(/File No\. CRA24-\d{4}/gi, '')
            .trim()
    ).join('\n');
    
    // Write the markdown content to a file
    fs.writeFileSync('output.md', markdownContent);
    
    console.log('Markdown file has been created: output.md');
}

// Path to the local HTML file
let filePath = 'test.html';

// Call the function
scrapeFromLocalFile(filePath);