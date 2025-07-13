# Tampa City Council Agenda Scraper

A Node.js application that scrapes Tampa City Council agendas and generates clean, readable markdown and WordPress-compatible HTML output with supporting documents and background information.

## Features

- **Clean Agenda Items**: Removes legal boilerplate text while preserving essential information
- **Supporting Documents**: Extracts and displays links to all supporting documents with direct PDF URLs
- **Background Information**: Automatically extracts "Background" sections from Summary Sheet PDFs with proper formatting
- **Robust PDF Parsing**: Structure-based text formatting that preserves numbered lists and paragraph breaks
- **Meeting Date Extraction**: Automatically extracts meeting dates from PDFs for filename and heading generation
- **Dollar Amount Tables**: Generates summary tables with all financial amounts from agenda items
- **Dual Output**: Generates both markdown (.md) and WordPress HTML (.wp.html) files
- **WordPress Integration**: Uses proper WordPress block markup with collapsible details sections
- **Title Case Formatting**: Automatically formats document link text to proper title case

## Output Examples

### Markdown Output

- Clean, readable agenda items
- Supporting documents as markdown links
- Background sections as plain text

### WordPress Output

- Proper WordPress block markup
- Collapsible background sections using `<details>` blocks
- Supporting documents with `target="_blank"` links
- Interactive zoning map for development applications
- CSS styling with theme.json color variables

## Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Install Chrome/Chromium browser for PDF text extraction

## Usage

Run the scraper:

```bash
node agenda-scraper.js
```

This will:

1. Scrape the latest Tampa City Council agenda
2. Extract supporting documents and background information
3. Generate both markdown and WordPress HTML files in the `agendas/` directory

## Output Files

- `agenda_[meetingId].md` - Markdown format
- `agenda_[meetingId].wp.html` - WordPress-compatible HTML

## Dependencies

- **selenium-webdriver**: Browser automation for PDF text extraction
- **cheerio**: HTML parsing and manipulation
- **axios**: HTTP requests for web scraping
- **pdf-parse**: PDF text extraction (alternative method)

## File Structure

- `agenda-scraper.js` - Main scraper script
- `wordpress-functions.js` - WordPress HTML generation
- `format-helpers.js` - Text formatting utilities
- `agenda-styles.css` - Frontend CSS for WordPress
- `editor-agenda-styles.css` - Editor CSS for WordPress admin

## Version History

### v1.1.1

- **Production Code Cleanup**: Removed extensive debugging code and console.log statements for cleaner production output
- **File Organization**: Deleted obsolete utility files (background-extractor.js, parse-meeting.js, parse-pdf.js, selenium-background-extractor.js, single-scraper.js)
- **Debug Artifact Removal**: Cleaned up debug directory and test files from development sessions
- **Essential Logging Restoration**: Preserved critical user feedback messages for markdown and WordPress file creation
- **Maintainability Improvements**: Streamlined codebase for better production readiness and maintenance

### v1.1.0

- **Fixed PDF Background Formatting**: Implemented robust structure-based PDF text formatting that properly preserves numbered lists and paragraph breaks (closes #1)
- **Enhanced Meeting Date Extraction**: Improved date parsing from Summary Sheet PDFs with better error handling
- **Dollar Amount Preservation**: Fixed regex patterns to prevent corruption of monetary values during text processing
- **Structural Text Processing**: Replaced brittle word-based pattern matching with structure-based approach that trusts PDF parser output
- **Multi-Paragraph Support**: Correctly handles multiple paragraph breaks in background sections

### v1.0.0

- Complete rewrite with supporting documents and background extraction
- WordPress block markup output
- CSS theme integration
- Title case formatting for document links
- Interactive zoning map integration
- Automated PDF text extraction using browser automation

## License

MIT License

## Author

Michael Bishop (https://michaelbishop.me/)
