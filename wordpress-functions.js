const fs = require('fs');
const path = require('path');

/**
 * Convert text to title case, preserving acronyms and file extensions
 * @param {string} text - The text to convert
 * @returns {string} - Title case text
 */
function toTitleCase(text) {
    // Handle file extensions and preserve them
    const fileExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt'];
    let preservedExtension = '';
    
    // Check if text ends with a file extension
    for (const ext of fileExtensions) {
        if (text.toLowerCase().endsWith(ext)) {
            preservedExtension = text.slice(-ext.length);
            text = text.slice(0, -ext.length);
            break;
        }
    }
    
    // Words that should remain lowercase (articles, prepositions, conjunctions)
    const lowercaseWords = [
        'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'if', 'in', 'nor', 
        'of', 'on', 'or', 'so', 'the', 'to', 'up', 'yet', 'with', 'from'
    ];
    
    // Words/patterns that should remain uppercase (common acronyms)
    const uppercasePatterns = [
        /^(TPD|FSA|HPC|DOT|FDOT|DLE|FBI|DEA|ATF|HIDTA|PDF|DOC|DOCX|XLS|XLSX)$/i,
        /^\d{2,4}$/  // Years like 2025, numbers
    ];
    
    // Split text into words while preserving separators
    const parts = text.split(/(\s+|-+|_+)/);
    
    return parts.map((part, index) => {
        // Keep separators as-is
        if (/^\s+$|^-+$|^_+$/.test(part)) {
            return part;
        }
        
        // Skip empty parts
        if (!part) return part;
        
        // Check if word should remain uppercase
        for (const pattern of uppercasePatterns) {
            if (pattern.test(part)) {
                return part.toUpperCase();
            }
        }
        
        // Count actual words (not separators) for title case logic
        const wordIndex = parts.slice(0, index).filter(p => !/^\s+$|^-+$|^_+$/.test(p) && p).length;
        
        // First word is always capitalized
        if (wordIndex === 0) {
            return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
        }
        
        // Check if word should be lowercase
        if (lowercaseWords.includes(part.toLowerCase())) {
            return part.toLowerCase();
        }
        
        // Regular title case
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    }).join('') + preservedExtension;
}

/**
 * Clean up redundant legalese text from agenda items
 */
/**
 * Format background text for WordPress with proper block structure
 * @param {string} backgroundText - The background text to format
 * @returns {string} - WordPress-formatted background content
 */
function formatBackgroundForWordPress(backgroundText) {
    if (!backgroundText || backgroundText.trim().length === 0) {
        return '';
    }
    
    // Split by double line breaks (which should separate numbered items after our formatting)
    const sections = backgroundText.split(/\n\s*\n/).filter(section => section.trim().length > 0);
    
    let formattedContent = '';
    let listItems = [];
    let regularParagraphs = [];
    
    sections.forEach(section => {
        const trimmedSection = section.trim();
        
        // Check if this looks like a numbered item
        if (trimmedSection.match(/^\d+\.\s/)) {
            // Remove the number and period, keep the rest
            const itemText = trimmedSection.replace(/^\d+\.\s*/, '');
            listItems.push(itemText);
        } else {
            // Regular paragraph
            regularParagraphs.push(trimmedSection);
        }
    });
    
    // Add ordered list if we have numbered items
    if (listItems.length > 0) {
        formattedContent += `\n<!-- wp:list {"ordered":true} -->
<ol>`;
        listItems.forEach(item => {
            formattedContent += `\n<!-- wp:list-item -->
<li>${item}</li>
<!-- /wp:list-item -->`;
        });
        formattedContent += `\n</ol>
<!-- /wp:list -->`;
    }
    
    // Add regular paragraphs
    regularParagraphs.forEach(paragraph => {
        formattedContent += `\n<!-- wp:paragraph -->
<p>${paragraph}</p>
<!-- /wp:paragraph -->`;
    });
    
    // If no structured content was found, treat as single paragraph
    if (formattedContent.trim().length === 0) {
        formattedContent = `\n<!-- wp:paragraph -->
<p>${backgroundText.replace(/\n/g, ' ').trim()}</p>
<!-- /wp:paragraph -->`;
    }
    
    return formattedContent;
}

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

function generateWordPressOutput(orderedListItems, supportingDocs, meetingId, sourceUrl, backgroundSections = []) {
  // Transform the URL to the correct format
  const correctedUrl = sourceUrl
    .replace('/Documents/ViewAgenda', '/Meetings/ViewMeeting')
    .replace('meetingId=', 'id=')
    .replace('&type=agenda', '');
  
  // Generate the intro blocks with the corrected URL
  let wpHtml = `<!-- wp:paragraph -->
<p>This is a reimagined version of the Tampa City Council agenda. It removes legalese from the description, parses the Background details from the Summary Sheet when available and provides links to supporting documents. Also included is a zoning map with current applications. A note about document links, Onbase links can change, and you can always refer to the official draft agenda from the clerk in Onbase.</p>
<!-- /wp:paragraph -->

<!-- wp:group {"layout":{"type":"flex","flexWrap":"nowrap"}} -->
<div class="wp-block-group"><!-- wp:coblocks/icon {"icon":"page","href":"${correctedUrl}"} /-->

<!-- wp:paragraph {"fontSize":"large"} -->
<p class="has-large-font-size"><a href="${correctedUrl}">City Clerk's Draft Agenda in Onbase</a></p>
<!-- /wp:paragraph --></div>
<!-- /wp:group -->\n\n`;
  
  // Process items to identify where the split should occur
  const processedItems = [];
  let firstStrongIndex = -1;
  
  // Extract file numbers for the map
  const fileNumberMatches = [];
  
  // Process each item and track the first occurrence of <strong>
  orderedListItems.forEach((item, index) => {
    let cleanedText = cleanAgendaContent(item);
    
    let itemNumber = index + 1;
    let numberMatch = cleanedText.match(/^(\d+)\./);
    if (numberMatch) {
      itemNumber = numberMatch[1];
      cleanedText = cleanedText.replace(/^\d+\./, '').trim();
    }
    
    // Add background section if available
    if (backgroundSections[index] && backgroundSections[index].trim().length > 0) {
      const formattedBackground = formatBackgroundForWordPress(backgroundSections[index].trim());
      cleanedText += `\n\n<!-- wp:details -->
<details class="wp-block-details"><summary>Background</summary>${formattedBackground}</details>
<!-- /wp:details -->`;
    }
    
    // Add supporting documents if available
    if (supportingDocs[index] && supportingDocs[index].length > 0) {
      cleanedText += `\n\n<div class="agenda-supporting-docs">
<h4>Supporting Documents:</h4>
<!-- wp:list -->
<ul class="wp-block-list">`;
      
      supportingDocs[index].forEach(doc => {
        const docUrl = doc.href.startsWith('http') ? doc.href : 'https://tampagov.hylandcloud.com' + doc.href.replace(/&amp;/g, '&');
        const titleCaseText = toTitleCase(doc.text || doc.title || 'Document');
        cleanedText += `
<!-- wp:list-item -->
<li><a href="${docUrl}" target="_blank" rel="noopener noreferrer">${titleCaseText}</a></li>
<!-- /wp:list-item -->`;
      });
      
      cleanedText += `
</ul>
<!-- /wp:list -->
</div>`;
    }
    
    // Check if this item will have a strong tag after conversion
    const hasStrongTag = /\*\*File No\. (DE[12]|TA\/CPA|REZ|VAC|AB[12]|SU\d?)/i.test(cleanedText);
    
    // If this has a strong tag, extract the file number and list number for the map
    if (hasStrongTag) {
      const fileNoMatch = cleanedText.match(/\*\*File No\. ([A-Z\/\d-]+)\*\*/);
      if (fileNoMatch) {
        const fileNo = fileNoMatch[1];
        // Split on last dash and pad number with zeros
        const [prefix, num] = fileNo.split(/-(?=[^-]+$)/);
        const paddedNum = num.padStart(7, '0');
        const paddedFileNo = `${prefix}-${paddedNum}`;
        fileNumberMatches.push(`${paddedFileNo}:${itemNumber}`);
      }
    }
    
    // Convert markdown bold syntax to HTML strong tags
    cleanedText = cleanedText.replace(/\*\*(File No\. (DE[12]-\d{2}-\d{2}(?:-[A-Z])?|TA\/CPA\d{2}-\d{2}|REZ-\d{2}-\d{2}|VAC-\d{2}-\d{4}|AB[12]-\d{2}-\d{2}|SU\d?-\d{2}-\d{2}))\*\*/gi, '<strong>$1</strong>');
    
    // Store the processed item with supporting docs
    processedItems.push({ itemNumber, cleanedText, hasStrongTag });
    
    // Track the first occurrence of a strong tag
    if (hasStrongTag && firstStrongIndex === -1) {
      firstStrongIndex = processedItems.length - 1;
    }
  });
  
  // If we found a strong tag, split the list
  if (firstStrongIndex !== -1) {
    // First part of the list - using WordPress block format
    wpHtml += `<!-- wp:list {"ordered":true} -->\n<ol class="wp-block-list">\n`;
    for (let i = 0; i < firstStrongIndex; i++) {
      const { cleanedText } = processedItems[i];
      wpHtml += `<!-- wp:list-item -->\n<li>${cleanedText}</li>\n<!-- /wp:list-item -->\n`;
    }
    wpHtml += `</ol>\n<!-- /wp:list -->\n\n`;
    
    // Add heading for Public Hearings & Ordinances
    wpHtml += `<!-- wp:heading {"level":3} -->\n<h3>Public Hearings & Ordinances</h3>\n<!-- /wp:heading -->\n\n`;
    
    // Add the map block using the extracted file numbers
    if (fileNumberMatches.length > 0) {
      const recordsStr = fileNumberMatches.join(', ');
      wpHtml += `<!-- wp:map-current-dev/block {"apiToken":"pk.eyJ1IjoibWlrbGIiLCJhIjoiY2x6OThxcWlwMDB2ajJrcTR3dGJkNjBpOCJ9.x64atltv8LBQAjtuGTUvrA","records":"${recordsStr}"} -->
<div class="wp-block-map-current-dev-block mapbox-block" data-token="pk.eyJ1IjoibWlrbGIiLCJhIjoiY2x6OThxcWlwMDB2ajJrcTR3dGJkNjBpOCJ9.x64atltv8LBQAjtuGTUvrA" data-center="[-82.4572,27.9506]" data-zoom="11" data-geojson-endpoint="https://arcgis.tampagov.net/arcgis/rest/services/OpenData/Planning/MapServer/31/query?outFields=*&amp;where=1%3D1&amp;f=geojson" data-records="${recordsStr}" data-show-geocoder="true" data-geocoder-position="top-right" data-show-legend="true" data-legend-position="bottom-left"></div>
<!-- /wp:map-current-dev/block -->\n\n`;
    }
    
    // Second part of the list using WordPress block format with start attribute
    const startNumber = processedItems[firstStrongIndex].itemNumber;
    wpHtml += `<!-- wp:list {"ordered":true,"start":${startNumber}} -->\n<ol start="${startNumber}" class="wp-block-list">\n`;
    for (let i = firstStrongIndex; i < processedItems.length; i++) {
      const { cleanedText } = processedItems[i];
      wpHtml += `<!-- wp:list-item -->\n<li>${cleanedText}</li>\n<!-- /wp:list-item -->\n`;
    }
    wpHtml += `</ol>\n<!-- /wp:list -->\n`;
  } else {
    // Single list - WordPress block format
    wpHtml += `<!-- wp:list {"ordered":true} -->\n<ol class="wp-block-list">\n`;
    processedItems.forEach(({ cleanedText }) => {
      wpHtml += `<!-- wp:list-item -->\n<li>${cleanedText}</li>\n<!-- /wp:list-item -->\n`;
    });
    wpHtml += `</ol>\n<!-- /wp:list -->\n`;
  }
  
  // Write the WordPress HTML file
  const outputDir = path.join(__dirname, 'agendas');
  let outputFileName = path.join(outputDir, `agenda_${meetingId}.wp.html`);
  fs.writeFileSync(outputFileName, wpHtml);
  
  console.log(`Successfully created WordPress-compatible file: ${outputFileName}`);
}

module.exports = {
    generateWordPressOutput,
    cleanAgendaContent,
    toTitleCase
};
