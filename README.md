# Tampa City Council Agenda Scraper

A Node.js application that scrapes Tampa City Council agendas and generates clean, readable markdown and WordPress-compatible HTML output with supporting documents and background information.

## Features

- **Clean Agenda Items**: Removes legal boilerplate text while preserving essential information
- **Supporting Documents**: Extracts and displays links to all supporting documents with direct PDF URLs
- **Background Information**: Automatically extracts "Background" sections from Summary Sheet PDFs
- **Dual Output**: Generates both markdown (.md) and WordPress HTML (.wp.html) files
- **WordPress Integration**: Uses proper WordPress block markup with collapsible details sections
- **Zoning Map**: Includes interactive map showing current development applications
- **Title Case Formatting**: Automatically formats document link text to proper title case
- **Theme Integration**: CSS styled to match WordPress theme variables

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
- `selenium-background-extractor.js` - PDF background extraction
- `agenda-styles.css` - Frontend CSS for WordPress
- `editor-agenda-styles.css` - Editor CSS for WordPress admin

## Version History

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
