#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pdfParse = require('pdf-parse');

/**
 * Parse a meeting calendar PDF
 * @param {string} url - URL to the PDF file
 */
async function parsePDF(url) {
    try {
        // Extract meeting ID from URL
        const meetingIdMatch = url.match(/id=(\d+)/) || url.match(/meetingId=(\d+)/);
        const meetingId = meetingIdMatch ? meetingIdMatch[1] : 'unknown';
        
        console.log(`Downloading PDF for meeting ID: ${meetingId}`);
        
        // Download the PDF file
        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'arraybuffer'
        });
        
        console.log(`PDF downloaded (${response.data.byteLength} bytes), extracting text...`);
        
        // Parse the PDF content
        const pdfData = await pdfParse(response.data);
        const pdfText = pdfData.text;
        
        console.log(`Successfully extracted ${pdfText.length} characters of text from PDF`);
        
        // Save raw text for debugging
        const debugDir = path.join(process.cwd(), 'debug');
        if (!fs.existsSync(debugDir)) {
            fs.mkdirSync(debugDir);
        }
        fs.writeFileSync(path.join(debugDir, `meeting_${meetingId}_raw.txt`), pdfText);
        
        // Process the text to create nicely formatted markdown
        let markdownContent = "# City Council Calendar\n\n";
        
        // Find and format month sections
        const monthRegex = /(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)(\s+continued|\s+cont\.)?(\s*-\s*\d{4})/gi;
        
        let formattedText = pdfText;
        
        // Remove header/footer content
        formattedText = formattedText.replace(/Skip to main content.*?Contact/s, ''); 
        formattedText = formattedText.replace(/CIL CALENDAR INFORMATION.*$/s, '');
        
        // Normalize special characters
        formattedText = formattedText
            .replace(/–/g, '-')    // Replace en dashes with regular hyphens
            .replace(/—/g, '-')    // Replace em dashes with regular hyphens
            .replace(/\u2013/g, '-') // Unicode for en dash
            .replace(/\u2014/g, '-') // Unicode for em dash
            .replace(/\u2018/g, "'") // Smart single quotes (opening)
            .replace(/\u2019/g, "'") // Smart single quotes (closing)
            .replace(/\u201C/g, '"') // Smart double quotes (opening)
            .replace(/\u201D/g, '"') // Smart double quotes (closing)
            .replace(/\u00A0/g, ' '); // Non-breaking spaces
        
        // More comprehensive character normalization
        formattedText = pdfText
            // Normalize dashes and hyphens
            .replace(/–/g, '-')     // en dash
            .replace(/—/g, '-')     // em dash
            .replace(/\u2013/g, '-') // Unicode en dash
            .replace(/\u2014/g, '-') // Unicode em dash
            .replace(/\u2212/g, '-') // Unicode minus
            
            // Normalize quotes
            .replace(/[""]/g, '"')  // Smart double quotes
            .replace(/['′]/g, "'")  // Smart single quotes/prime
            
            // Normalize spaces
            .replace(/\u00A0/g, ' ') // Non-breaking space
            .replace(/\u200B/g, '')  // Zero-width space
            .replace(/\s+/g, ' ')    // Normalize all whitespace
            
            // Other common special characters
            .replace(/•/g, '*')     // Bullet points to asterisks
            .replace(/…/g, '...');  // Ellipsis to three periods

        // Format month headers
        formattedText = formattedText.replace(monthRegex, '\n\n## $&\n\n');
        
        // Format meeting dates (with date extraction)
        formattedText = formattedText.replace(
            /(\d+)\s+(CITY COUNCIL|COMMUNITY REDEVELOPMENT AGENCY|CRA)\s+(REGULAR|WORKSHOP|EVENING|SPECIAL CALL)\s+SESSION/gi,
            '\n\n### $1 $2 $3 SESSION\n\n'
        );
        
        // Format times
        formattedText = formattedText.replace(/(\d+:\d+\s*[ap]\.m\.)/gi, '**$1**');
        
        // Format file numbers
        formattedText = formattedText.replace(/File No\.\s+([A-Z0-9-]+)/gi, '**File No. $1**');
        
        // Format staff reports section headers
        formattedText = formattedText.replace(
            /(Staff Reports & Unfinished Business|Written Staff Reports)\s+\((\d+)\)\s+–\s+\(Brief description below\):/gi,
            '\n\n#### $1 ($2)\n\n'
        );
        
        // Format workshops section headers
        formattedText = formattedText.replace(
            /Workshops\s+\((\d+)\)\s+-\s+\(Brief description below\):/gi,
            '\n\n#### Workshops ($1)\n\n'
        );
        
        // Clean up line breaks and spacing
        formattedText = formattedText.replace(/\n{3,}/g, '\n\n');
        
        // Add formatted text to markdown content
        markdownContent += formattedText;
        
        // Add source URL at the bottom
        markdownContent += `\n\n---\n*Source: [Original Calendar Document](${url})*`;
        
        // Create output directory
        const outputDir = path.join(process.cwd(), 'output');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir);
        }
        
        // Write to file
        const outputFile = path.join(outputDir, `meeting_${meetingId}.md`);
        fs.writeFileSync(outputFile, markdownContent);
        
        console.log(`Calendar content extracted to ${outputFile}`);
        return true;
    } catch (error) {
        console.error("Error parsing PDF:", error);
        return false;
    }
}

// Get command line arguments
const url = process.argv[2];

if (!url) {
    console.error('Please provide a PDF URL as an argument');
    console.log('Usage: node parse-pdf.js <pdf-url>');
    process.exit(1);
}

// Execute the parser
parsePDF(url)
    .then(success => {
        if (success) {
            console.log('PDF parsing completed successfully');
        } else {
            console.error('PDF parsing failed');
            process.exit(1);
        }
    })
    .catch(err => {
        console.error('Error executing PDF parser:', err);
        process.exit(1);
    });