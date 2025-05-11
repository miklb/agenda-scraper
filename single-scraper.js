const { Builder, By } = require('selenium-webdriver');
const cheerio = require('cheerio');
const fs = require('fs');

// Function to scrape a single meeting by ID
async function scrapeWithSelenium(url, meetingId) {
    // Set up the Selenium WebDriver
    let driver = await new Builder().forBrowser('chrome').build();
    
    try {
        // Load the page
        await driver.get(url);
        
        // Extract the page source
        let pageSource = await driver.getPageSource();
        
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
        
        // Convert the ordered list items to markdown format and strip unwanted patterns
        let markdownContent = orderedListItems.map(item => 
            item.replace(/\s+/g, ' ')
                .replace(/\(Original Motion[^)]*\)/gi, '')
                .replace(/\(To be R\/F\)/gi, '')
                .replace(/\(Continued[^)]*\)/gi, '')
                .replace(/File No\. CRA24-\d{4}/gi, '')
                .replace(/File No.\ [A-Z]{3}-\d{2}-\d{2}/gi, '')
                .replace(/\(Rescheduled from[^)]*\)/gi, '')
                .replace(/\(Ordinance being presented[^)]*\)/gi, '')
                .replace(/an ordinance.*?providing an effective date\./gi, '')
                .replace(/\(6\)c\)\s*-\s*/gi, '')
                .trim()
        ).join('\n');
        
        // Write the markdown content to a file with the meetingId appended to the filename
        let outputFileName = `agenda_${meetingId}.md`;
        fs.writeFileSync(outputFileName, markdownContent);
        
        console.log(`Markdown file has been created: ${outputFileName}`);
    } finally {
        // Quit the driver
        await driver.quit();
    }
}

// Get the meetingId from command-line arguments
const args = process.argv.slice(2);
let meetingIdArg = args.find(arg => arg.startsWith('meetingid='));
if (!meetingIdArg) {
    console.error('Error: meetingid argument is required');
    process.exit(1);
}
let meetingId = meetingIdArg.split('=')[1];

// URL of the page to scrape
let url = `https://tampagov.hylandcloud.com/221agendaonline/Documents/ViewAgenda?meetingId=${meetingId}&type=agenda&doctype=1`;

// Call the function
scrapeWithSelenium(url, meetingId);