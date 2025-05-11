#!/usr/bin/env node
const { Builder, By, until } = require('selenium-webdriver');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

async function parseMeeting(url) {
    let driver = await new Builder().forBrowser('chrome').build();
    
    try {
        await driver.get(url);
        
        // Wait for content to load
        await driver.wait(until.elementLocated(By.css('body')), 10000);
        
        // Extract meeting ID more robustly
        let meetingId = url.match(/id=(\d+)/)?.[1] || url.match(/meetingId=(\d+)/)?.[1] || 'unknown';
        console.log(`Parsing meeting ID: ${meetingId}`);
        
        // Try multiple URL formats to see which one works
        let agendaUrl = url;
        let sourceAttempts = [url];
        
        // If we're on the meeting view, try both agenda and calendar document views
        if (url.includes('/Meetings/ViewMeeting')) {
            // Try agenda document view
            const agendaDocUrl = url.replace('/Meetings/ViewMeeting', '/Documents/ViewAgenda')
                          .replace('id=', 'meetingId=')
                          .replace('&doctype=3', '&type=agenda&doctype=1');
            sourceAttempts.push(agendaDocUrl);
            console.log(`Trying agenda document URL: ${agendaDocUrl}`);
            
            // Try calendar summary view (for calendar documents)
            const calendarUrl = url.replace('/Meetings/ViewMeeting', '/Documents/ViewAgenda')
                              .replace('id=', 'meetingId=')
                              .replace('&doctype=3', '&type=summary&doctype=3');
            sourceAttempts.push(calendarUrl);
            console.log(`Trying calendar summary URL: ${calendarUrl}`);
            
            // Try doctype=2 alternative
            const altUrl = url.replace('/Meetings/ViewMeeting', '/Documents/ViewAgenda')
                           .replace('id=', 'meetingId=')
                           .replace('&doctype=3', '&type=summary&doctype=2');
            sourceAttempts.push(altUrl);
        }
        
        // Try both URLs and use the one that has content
        let $ = null;
        let pageSource = '';
        let contentFound = false;
        
        for (const attemptUrl of sourceAttempts) {
            await driver.get(attemptUrl);
            await driver.wait(until.elementLocated(By.css('body')), 10000);
            
            // Give extra time for JavaScript rendering
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            pageSource = await driver.getPageSource();
            $ = cheerio.load(pageSource);
            
            // Check if we found content
            const hasAgendaItems = $('table').length > 0 || $('.agenda-item').length > 0;
            if (hasAgendaItems) {
                console.log(`Found content at URL: ${attemptUrl}`);
                contentFound = true;
                break;
            }
        }
        
        // If no content found from normal URLs, try the direct agenda PDF link
        if (!contentFound) {
            console.log("No content found in HTML views, trying to find PDF links...");
            await driver.get(url);
            await driver.wait(until.elementLocated(By.css('body')), 10000);
            
            // Look for agenda PDF links
            const pdfLinks = await driver.findElements(By.css('a[href*="agenda"][href$=".pdf"], a:contains("Agenda")'));
            if (pdfLinks.length > 0) {
                const pdfUrl = await pdfLinks[0].getAttribute('href');
                console.log(`Found PDF agenda link: ${pdfUrl}`);
                // Note: PDF parsing would require additional tools
                fs.writeFileSync(path.join('output', `meeting_${meetingId}_pdf_link.txt`), pdfUrl);
            }
        }
        
        // If we got to this point and $ is null, something went wrong
        if (!$) {
            console.error("Failed to load content from any URL attempt");
            return false;
        }
        
        console.log(`Page title: "${$('title').text().trim()}"`);
        
        // Extract calendar data
        const calendarData = extractCalendarData($);
        console.log('Calendar data:', calendarData);
        
        // Initialize an array to hold the ordered list items
        let orderedListItems = [];
        
        // Verify tables exist
        const tables = $('table');
        console.log(`Found ${tables.length} tables on the page`);
        
        if (tables.length === 0) {
            console.error(`No tables found for meeting ${meetingId}`);
            return false;
        }
        
        // Find all tables with the specified structure
        tables.each((i, table) => {
            // Try different selectors to find numbered items
            const hasNumberSpan = $(table).find('td > p > span').filter((i, span) => {
                return /^\d+\.$/.test($(span).text().trim());
            }).length > 0;
            
            // If using the primary method to find numbered items
            if (hasNumberSpan) {
                // Extract the table content and preserve structure
                let combinedContent = '';
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
                }
            }
            // Alternative: Look for any content that appears to be agenda items
            else if (i < 10) { // Only check first few tables to avoid menu/nav tables
                const tableText = $(table).text().trim();
                // Look for patterns that suggest this is an agenda table
                if (tableText.match(/\d+\.\s+/) && tableText.length > 100) {
                    console.log(`Found potential agenda table: ${tableText.substring(0, 100)}...`);
                    orderedListItems.push(tableText);
                }
            }
        });
        
        // If still no items found, try a broader approach
        if (orderedListItems.length === 0) {
            console.log("No items found with standard methods, trying broader extraction...");
            
            // Look for any text that resembles agenda items across many element types
            $('div, section, li, tr, p').each((i, element) => {
                const text = $(element).text().trim();
                
                // Look for numbered items (1., 2., etc.) with substantial content
                if (text.match(/^\d+\.\s+.{15,}/) || 
                    // Also match File No. patterns that might indicate agenda items
                    text.match(/File No\. [A-Z]{2,3}\d{2}-\d+/i)) {
                    console.log(`Found potential agenda item: ${text.substring(0, 50)}...`);
                    orderedListItems.push(text);
                }
            });
            
            // Deduplicate items that might have been caught multiple times
            const uniqueItems = [...new Set(orderedListItems)];
            orderedListItems = uniqueItems;
        }

        // After trying the other extraction methods, try this specific approach for calendar format
        if (orderedListItems.length === 0) {
            console.log("Using calendar text extraction method...");
            
            // Wait longer for dynamic content to load completely
            try {
                console.log("Waiting for dynamic calendar content to load...");
                await driver.sleep(3000); // Add extra wait time for JS to render
                
                // Try to click any "View Document" button that might trigger content
                const viewButtons = await driver.findElements(By.css('a.btn, button:contains("View")'));
                if (viewButtons.length > 0) {
                    await viewButtons[0].click();
                    await driver.sleep(2000); // Wait after clicking
                }
                
                // Get updated page source after dynamic content loads
                pageSource = await driver.getPageSource();
                $ = cheerio.load(pageSource);
                
                // Try to find content in different potential containers
                const containers = ['#content-pane', '.document-view', '.doc-content', '#main-content', 'body'];
                
                for (const container of containers) {
                    const docText = $(container).text();
                    if (docText && docText.length > 500) { // Only process substantial content
                        console.log(`Found content in ${container}, length: ${docText.length}`);
                        
                        // Extract month headers and their content
                        const monthHeaders = docText.match(/(?:JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)(?:\s+(?:continued|cont\.)?)?\s*-\s*\d{4}/gi);
                        
                        if (monthHeaders && monthHeaders.length > 0) {
                            console.log(`Found ${monthHeaders.length} month headers in document`);
                            
                            // Create markdown calendar structure
                            let calendarMarkdown = "# City Council Meeting Calendar\n\n";
                            
                            // Split by month headers and process each section
                            const parts = docText.split(/(?:JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)(?:\s+(?:continued|cont\.)?)?\s*-\s*\d{4}/gi);
                            
                            // Process each month section
                            for (let i = 0; i < monthHeaders.length; i++) {
                                const monthHeader = monthHeaders[i];
                                const monthContent = parts[i+1] || '';
                                
                                if (monthContent) {
                                    // Add month header to markdown
                                    calendarMarkdown += `## ${monthHeader}\n\n`;
                                    
                                    // Split content by meeting dates
                                    const meetingDates = monthContent.match(/\d+\s+(?:CITY COUNCIL|COMMUNITY REDEVELOPMENT AGENCY|CRA)\s+(?:REGULAR|WORKSHOP|EVENING|SPECIAL CALL)\s+SESSION/gi) || [];
                                    
                                    if (meetingDates.length > 0) {
                                        for (let j = 0; j < meetingDates.length; j++) {
                                            const meetingDate = meetingDates[j];
                                            
                                            // Find this meeting's content
                                            const meetingStart = monthContent.indexOf(meetingDate);
                                            let meetingEnd = monthContent.length;
                                            
                                            // Find end of this meeting (start of next meeting or section)
                                            if (j < meetingDates.length - 1) {
                                                meetingEnd = monthContent.indexOf(meetingDates[j+1], meetingStart);
                                            }
                                            
                                            if (meetingStart >= 0 && meetingEnd > meetingStart) {
                                                const meetingContent = monthContent.substring(meetingStart, meetingEnd).trim();
                                                
                                                // Format meeting header
                                                const dateMatch = meetingDate.match(/(\d+)\s+/);
                                                const date = dateMatch ? dateMatch[1] : '';
                                                
                                                calendarMarkdown += `### ${date} - ${meetingDate.replace(/^\d+\s+/, '')}\n\n`;
                                                
                                                // Format meeting content, removing the header we already used
                                                const cleanContent = meetingContent.replace(meetingDate, '').trim()
                                                    .replace(/\s+/g, ' ')
                                                    .replace(/([0-9]):([0-9])/g, '$1:$2'); // Fix time formats
                                                    
                                                calendarMarkdown += `${cleanContent}\n\n`;
                                            }
                                        }
                                    } else {
                                        // If no meeting dates, just include the month's content
                                        calendarMarkdown += `${monthContent.trim().replace(/\s+/g, ' ')}\n\n`;
                                    }
                                }
                            }
                            
                            // Save the markdown content
                            const outputDir = path.join(process.cwd(), 'output');
                            if (!fs.existsSync(outputDir)) {
                                fs.mkdirSync(outputDir);
                            }
                            
                            const outputFile = path.join(outputDir, `meeting_${meetingId}.md`);
                            fs.writeFileSync(outputFile, calendarMarkdown);
                            
                            console.log(`Calendar content extracted to ${outputFile}`);
                            contentFound = true;
                            break;
                        } else {
                            console.log("No month headers found in document text");
                            
                            // Save debug file with the text content
                            const debugDir = path.join(process.cwd(), 'debug');
                            if (!fs.existsSync(debugDir)) {
                                fs.mkdirSync(debugDir);
                            }
                            fs.writeFileSync(path.join(debugDir, `meeting_${meetingId}_text.txt`), docText);
                        }
                    }
                }
            } catch (error) {
                console.error("Error during calendar extraction:", error);
            }
        }

        // After trying other methods, add this as a last resort
        if (!contentFound) {
            console.log("Attempting direct browser text extraction...");
            
            try {
                // Wait for page to fully render
                await driver.sleep(5000);
                
                // Get text directly from browser
                const pageText = await driver.executeScript(
                    "return document.body.innerText || document.documentElement.innerText;"
                );
                
                if (pageText && pageText.length > 500) {
                    console.log(`Got ${pageText.length} characters directly from browser`);
                    
                    // Look for calendar structure (month headers)
                    if (pageText.match(/(?:JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+(?:continued|cont\.)?\s*-\s*\d{4}/i)) {
                        // Create a simple markdown version of the document
                        let markdown = "# Meeting Calendar\n\n";
                        
                        // Process the text, cleaning up formatting
                        const cleanText = pageText
                            .replace(/Skip to main content.*?Contact/s, '') // Remove navigation text
                            .replace(/Version:.*$/s, '') // Remove version info at the end
                            .replace(/\n{3,}/g, '\n\n') // Normalize line breaks
                            .trim();
                        
                        // Format month headers
                        let formattedText = cleanText.replace(
                            /(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)(?:\s+(?:continued|cont\.))?\s*-\s*\d{4}/gi,
                            '\n## $&\n'
                        );
                        
                        // Format meeting dates
                        formattedText = formattedText.replace(
                            /(\d+)\s+(CITY COUNCIL|COMMUNITY REDEVELOPMENT AGENCY|CRA)\s+(REGULAR|WORKSHOP|EVENING|SPECIAL CALL)\s+SESSION/gi,
                            '\n### $1 $2 $3 SESSION\n'
                        );
                        
                        // Format times
                        formattedText = formattedText.replace(
                            /(\d+:\d+\s*[ap]\.m\.)\s*-\s*/gi,
                            '**$1** - '
                        );
                        
                        markdown += formattedText;
                        
                        // Save the markdown file
                        const outputDir = path.join(process.cwd(), 'output');
                        if (!fs.existsSync(outputDir)) {
                            fs.mkdirSync(outputDir);
                        }
                        
                        const outputFile = path.join(outputDir, `meeting_${meetingId}.md`);
                        fs.writeFileSync(outputFile, markdown);
                        
                        console.log(`Calendar content extracted to ${outputFile}`);
                        contentFound = true;
                    }
                }
            } catch (error) {
                console.error("Error during direct text extraction:", error);
            }
        }

        // Save debug HTML if needed
        const debugDir = path.join(process.cwd(), 'debug');
        if (!fs.existsSync(debugDir)) {
            fs.mkdirSync(debugDir);
        }
        fs.writeFileSync(path.join(debugDir, `meeting_${meetingId}_html.txt`), pageSource);
        console.log(`Saved page source to debug/meeting_${meetingId}_html.txt for troubleshooting`);
        
        // Verify content was extracted
        if (orderedListItems.length === 0) {
            console.error(`No content extracted for meeting ${meetingId}`);
            return false;
        }

        console.log(`Extracted ${orderedListItems.length} agenda items`);
        
        return true;
    } catch (error) {
        console.error(`Error parsing meeting:`, error);
        return false;
    } finally {
        await driver.quit();
    }
}

function extractCalendarData($) {
    const data = {};
    
    // Try to extract meeting title
    const title = $('.meeting-details h1').text().trim();
    if (title) data.title = title;
    
    // Extract date, time, location from meeting details
    $('.meeting-meta-item').each((i, element) => {
        const label = $(element).find('.meeting-meta-label').text().trim().toLowerCase();
        const value = $(element).find('.meeting-meta-value').text().trim();
        
        if (label.includes('date')) {
            data.date = value;
        } else if (label.includes('time')) {
            data.time = value;
        } else if (label.includes('location')) {
            data.location = value;
        } else if (label.includes('department')) {
            data.department = value;
        }
    });
    
    return data;
}

// Get command line arguments
const url = process.argv[2];

if (!url) {
    console.error('Please provide a meeting URL as an argument');
    console.log('Usage: node parse-meeting.js <meeting-url>');
    process.exit(1);
}

// Execute the parser
parseMeeting(url)
    .then(success => {
        if (success) {
            console.log('Meeting parsing completed successfully');
        } else {
            console.error('Meeting parsing failed');
            process.exit(1);
        }
    })
    .catch(err => {
        console.error('Error executing parser:', err);
        process.exit(1);
    });