# Obsidian to Anytype Converter

A Node.js script that converts Obsidian notes (with links and files) to a zip file containing markdown files ready for upload to Anytype, using **Sets** to represent the vault structure. The script creates a single root Set (`vault.set.md`) that contains all root folders as a hierarchical structure with clickable links to pages.

## Features

- ✅ Converts Obsidian wiki-style links `[[Note Name]]` to standard markdown links
- ✅ Handles Obsidian image embeds `![[image.png]]` and standard markdown images
- ✅ **Creates a single root Set (`vault.set.md`)** with hierarchical folder structure
- ✅ **Pages in folders use `type: SetLeaf`** with root Set metadata
- ✅ **Root-level pages use `type: Page`** (no set metadata)
- ✅ Extracts and formats Obsidian tags as YAML objects in frontmatter
- ✅ Preserves folder structure with sanitized paths (spaces → underscores)
- ✅ Includes all attachments (images, PDFs, documents, audio, video, etc.)
- ✅ Recursively searches for images in attachments folders and subfolders
- ✅ Handles incorrectly formatted image/file paths (removes `.md` extension if present)
- ✅ Creates a zip file ready for Anytype import

## Installation

1. Install Node.js (v14 or higher)

2. Install dependencies:
```bash
npm install
```

## Usage

### Basic usage (default paths):
```bash
node to_anytype.js
```

This will:
- Look for Obsidian vault in `./vault` directory
- Create output file `./anytype_export.zip`

### Custom paths:
```bash
node to_anytype.js "path/to/obsidian/vault" "path/to/output.zip"
```

### Examples:
```bash
# Convert vault from default location
node to_anytype.js

# Convert specific vault
node to_anytype.js "C:\Users\YourName\Documents\MyVault" "my_export.zip"

# Using npm script
npm run convert
```

## How it works

1. **Root Set (`vault.set.md`)**:
   - Creates a single Set file at the root of the zip named `vault.set.md`
   - Contains `type: Set` and `name: vault` in frontmatter
   - Displays all root folders as a hierarchical structure using Markdown headings (h2, h3, h4, etc.)
   - Each folder level uses appropriate heading depth based on its depth from vault root
   - Contains clickable links to all pages (leaf markdown files)
   - Example: Root folders appear as `## FolderName`, subfolders as `### SubfolderName`, etc.

2. **Pages and SetLeaves**:
   - Pages inside folders use `type: SetLeaf` with `set: <rootFolderName>` metadata
   - Root-level pages (not in any folder) use `type: Page` (no set metadata)
   - Each SetLeaf references the root Set it belongs to (the root folder containing it)
   - Example: A note in `Projects/2024/Project1.md` gets `type: SetLeaf`, `set: Projects`
   - Example: A note in root `Note1.md` gets `type: Page` (no set)

3. **Link Conversion**: 
   - `[[Note Name]]` → `[Note Name](Note Name.md)`
   - `[[Note Name|Display Text]]` → `[Display Text](Note Name.md)`
   - Automatically finds the correct file path for links
   - Paths are sanitized (spaces → underscores) and use forward slashes

4. **Image and File Handling**:
   - `![[image.png]]` → `![image](Attachments/image.png)` (with correct path)
   - Standard markdown images `![alt](path)` are also processed
   - Recursively searches for images in:
     - Current file's directory and subdirectories
     - Root folder (e.g., SIGEO) and all subdirectories
     - Attachments folders (relative to file and vault root)
     - Entire vault (as last resort)
   - Handles incorrectly formatted paths (removes `.md` extension if present)
   - All paths are sanitized (spaces → underscores) and use forward slashes
   - Supports images, PDFs, and other document types

5. **Tag Extraction**:
   - Extracts Obsidian tags (e.g., `#tag`, `#tag/subtag`) from markdown content
   - Recognizes tags at start of line, after whitespace, or standalone (not embedded in words)
   - Adds tags to frontmatter as YAML objects (key-value pairs where key and value are the same)
   - Skips tags inside code blocks and inline code
   - Merges with existing tags if present
   - Debug logging shows which tags are found in each file

6. **File Inclusion**:
   - Includes all markdown files (`.md`, `.markdown`)
   - Includes all attachments: images, PDFs, documents, audio, video, archives, etc.
   - Excludes Obsidian-specific files (`.obsidian` folder, etc.)
   - All file paths are sanitized (spaces → underscores) to match link paths

7. **Folder Structure**:
   - Maintains the exact folder hierarchy from your Obsidian vault
   - All paths are sanitized (spaces → underscores) for consistency
   - The root Set file displays the complete folder structure with clickable links

## Output

The script creates a zip file containing:
- **Root Set file** (`vault.set.md`) at the root with hierarchical folder structure
- **Page files** (markdown files) with appropriate types:
  - `type: SetLeaf` for pages in folders (with `set: <rootFolderName>`)
  - `type: Page` for root-level pages (no set metadata)
- **All attachment files** (images, PDFs, documents, audio, video, etc.)
- **Preserved folder structure** with sanitized paths (spaces → underscores)

### Set and Page Structure Example

If your Obsidian vault has this structure:
```
vault/
├── Projects/
│   ├── 2024/
│   │   └── Project1.md
│   └── 2023/
│       └── Project2.md
└── Notes/
    └── Note1.md
```

The script will create:
- `vault.set.md` - **Root Set** with hierarchical structure:
  ```markdown
  ## Projects
  ### 2024
  - [Project1](Projects/2024/Project1.md)
  ### 2023
  - [Project2](Projects/2023/Project2.md)
  ## Notes
  - [Note1](Notes/Note1.md)
  ```
- `Projects/2024/Project1.md` - **SetLeaf** with `type: SetLeaf`, `set: Projects`
- `Projects/2023/Project2.md` - **SetLeaf** with `type: SetLeaf`, `set: Projects`
- `Notes/Note1.md` - **SetLeaf** with `type: SetLeaf`, `set: Notes`
- `RootNote.md` - **Page** with `type: Page` (root-level, no set)

Note: 
- The root Set file (`vault.set.md`) displays the complete folder hierarchy with clickable links to all pages
- All paths are sanitized (spaces → underscores) for consistency
- Pages in folders reference their root Set (the root folder containing them)

You can then upload this zip file to Anytype, where root folders become Sets, subfolders are nested under them, and pages inside Sets are marked as SetLeaves (to prevent deletion issues).

## Notes

- **Path Sanitization**: All file and folder paths are sanitized (spaces → underscores) to ensure consistency between links and actual file paths
- **Image Search**: The script performs comprehensive recursive searches for images in:
  - Current file's directory and subdirectories
  - Root folder (e.g., SIGEO) and all subdirectories
  - Attachments folders (both relative to file and vault root)
  - Entire vault (as last resort)
- **File Path Fixes**: Automatically removes incorrectly appended `.md` extensions from image and file paths (e.g., `image.png.md` → `image.png`)
- **Tag Formatting**: Tags are extracted from markdown content using improved regex that recognizes tags in various contexts (start of line, after whitespace, standalone). Tags are added to frontmatter as YAML objects (not arrays). The script includes debug logging to show which tags are found in each file.
- **Link Paths**: All link paths use forward slashes and are relative to vault root
- **Broken Links**: Broken links (to non-existent notes) are still converted but may not work in Anytype
- **Obsidian Features**: Obsidian-specific features like frontmatter and plugins are preserved as-is in the markdown
- **Page Types**: 
  - Pages inside folders: `type: SetLeaf` with `set: <rootFolderName>`
  - Root-level pages: `type: Page` (no set metadata)
- **Root Set**: A single `vault.set.md` file contains the complete folder hierarchy with clickable links
- **SetLeaves**: Reference the root Set they belong to (the root folder containing them), not intermediate subfolders

