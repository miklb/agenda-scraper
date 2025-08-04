# Tampa City Council Agenda Scraper v2.0

A Node.js application that scrapes Tampa City Council agendas, stores them as structured JSON, and generates clean WordPress block markup with enhanced navigation and formatting.

## 🆕 Version 2.0 Features

### **Two-Stage Processing Pipeline**

- **JSON Scraper**: Extracts and stores meeting data as structured JSON files
- **WordPress Converter**: Transforms JSON data into WordPress block markup
- **Flexible Workflow**: Process meetings individually or by date with command-line options

### **Enhanced Navigation & UX**

- **Session Headings**: Automatic "Morning Agenda" and "Evening Agenda" headings for multi-session days
- **Quick Navigation**: Jump links between morning and evening sessions
- **Anchor Links**: Direct linking to specific agenda sections with `#morning-agenda` and `#evening-agenda`
- **Smart Sorting**: Evening meetings always appear last, regardless of meeting types

### **Improved WordPress Integration**

- **Background Details**: Collapsible `<details>` blocks for agenda item backgrounds
- **Interactive Maps**: Automatic zoning maps for development applications with file number detection
- **Session Management**: Intelligent combining of same-date meetings into single WordPress files
- **Clean Markup**: Proper WordPress block structure with semantic HTML

### **Robust Data Storage**

- **Structured JSON**: Meeting data stored as searchable, reusable JSON files
- **Meeting Types**: Handles Regular, Evening, Special, and Workshop meetings
- **Date-based Organization**: Files organized by meeting dates for easy retrieval
- **Supporting Documents**: Complete document metadata with proper URL handling

## Quick Start

### Installation

```bash
npm install
```

### Basic Usage

**Process all meetings and convert today's agendas:**

```bash
npm run process
```

**Process specific date:**

```bash
npm run process 2025-08-07
```

**Individual commands:**

```bash
# Scrape meetings to JSON
npm run scrape

# Convert JSON to WordPress markup
npm run convert -- --date 2025-08-07
```

## Command Line Options

### JSON Scraper (`json-scraper.js`)

```bash
node json-scraper.js [options]

Options:
  --help, -h              Show help
  --start-date YYYY-MM-DD Start date for date range scraping
  --end-date YYYY-MM-DD   End date for date range scraping
```

### WordPress Converter (`json-to-wordpress.js`)

```bash
node json-to-wordpress.js [options]

Options:
  --help, -h                    Show help
  --date YYYY-MM-DD            Convert all meetings for specific date
  --meetings ID1,ID2,...       Convert specific meeting IDs

Examples:
  node json-to-wordpress.js 2634                    # Single meeting
  node json-to-wordpress.js --date 2025-07-31       # All meetings on date
  node json-to-wordpress.js -m 2634,2589            # Multiple meetings
```

## NPM Scripts

| Script                       | Description                                          |
| ---------------------------- | ---------------------------------------------------- |
| `npm run scrape`             | Run JSON scraper for all available meetings          |
| `npm run convert`            | Run WordPress converter (requires date/meeting args) |
| `npm run process`            | Complete workflow: scrape + convert today's meetings |
| `npm run process 2025-08-07` | Complete workflow for specific date                  |

## File Structure

### Core Scripts

- `json-scraper.js` - Extracts meeting data to JSON files
- `json-to-wordpress.js` - Converts JSON to WordPress markup
- `process-agenda.sh` - Automated workflow script
- `wordpress-functions.js` - WordPress formatting utilities

### Data Organization

```
agenda-scraper/
├── data/                           # JSON meeting data
│   ├── meeting_2589_2025-07-31.json
│   └── meeting_2634_2025-07-31.json
├── agendas/                        # WordPress output files
│   ├── agenda_2025-07-31.wp.html   # Combined morning + evening
│   └── agenda_2025-08-07.wp.html   # Single meeting
└── output/                         # Legacy markdown files
```

### Supporting Files

- `format-helpers.js` - Text cleaning and formatting
- `agenda-styles.css` - Frontend WordPress styles
- `editor-agenda-styles.css` - WordPress editor styles

## Output Examples

### Single Meeting Output

```html
<!-- Quick intro paragraph -->
<!-- Single "Agenda" heading with anchor -->
<!-- Meeting link and agenda items -->
```

### Multiple Meetings Output

```html
<!-- Quick intro paragraph -->
<!-- Navigation: Morning Agenda | Evening Agenda -->
<!-- Morning Agenda heading and items -->
<!-- Evening Agenda heading and items -->
```

### Enhanced Features

- **Background Details**: `<details>` blocks with "Background" summary
- **Supporting Documents**: Properly formatted document links
- **Interactive Maps**: Automatic map blocks for zoning applications
- **Smart Formatting**: File numbers in `<strong>` tags for development items

## Dependencies

- **selenium-webdriver**: Browser automation for web scraping
- **cheerio**: HTML parsing and content extraction
- **axios**: HTTP requests and web data fetching
- **pdf-parse**: PDF text extraction capabilities

## Version History

### v2.0.0 (Current)

- **🔄 Architecture Redesign**: Split into two-stage pipeline (JSON storage + WordPress conversion)
- **📱 Enhanced Navigation**: Added session headings and quick navigation links
- **🎯 Smart Meeting Sorting**: Evening meetings always appear last
- **⚓ Anchor Links**: Direct linking to morning/evening agenda sections
- **📁 Structured Data**: JSON-first approach with reusable meeting data
- **🛠 Flexible Workflow**: Command-line options for dates and meeting IDs
- **📋 NPM Scripts**: Streamlined processing with `npm run process`
- **🔧 Robust Error Handling**: Better validation and failure recovery
- **📊 Multiple Meeting Types**: Support for Regular, Evening, Special, Workshop meetings

### v1.2.0

- **Fixed Duplicate Content Issue**: Resolved agenda items with identical file numbers showing duplicate content
- **Enhanced Content Validation**: Improved wait conditions for reliable content loading
- **Retry Logic**: Added automatic retry mechanism for incorrect content detection

### v1.1.1

- **Production Code Cleanup**: Removed debugging code for cleaner output
- **File Organization**: Deleted obsolete utility files
- **Maintainability Improvements**: Streamlined codebase

### v1.1.0

- **Fixed PDF Background Formatting**: Structure-based text formatting preserving lists and paragraphs
- **Enhanced Meeting Date Extraction**: Improved date parsing with error handling
- **Dollar Amount Preservation**: Fixed monetary value corruption during processing

### v1.0.0

- Complete rewrite with supporting documents and background extraction
- WordPress block markup output and CSS theme integration
- Interactive zoning map integration and automated PDF text extraction

## License

MIT License

## Author

Michael Bishop (https://michaelbishop.me/)
