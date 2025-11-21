#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createWriteStream } = require('fs');
const archiver = require('archiver');

/**
 * Converts Obsidian notes to Anytype-compatible markdown files
 * Uses Sets to represent folders and subfolders
 * Only leaf markdown files are marked as Pages
 * Preserves folder structure and handles links and attachments
 */

// Configuration
const DEFAULT_VAULT_PATH = './vault';
const DEFAULT_OUTPUT_PATH = './anytype_export.zip';

// Get command line arguments
const args = process.argv.slice(2);
const vaultPath = args[0] || DEFAULT_VAULT_PATH;
const outputPath = args[1] || DEFAULT_OUTPUT_PATH;

// Track Sets for hierarchy
const sets = new Map(); // path -> set info

/**
 * Convert Obsidian wiki-style links [[Note Name]] to markdown links
 * Also handles aliases: [[Note Name|Display Text]]
 */
function convertObsidianLinks(content, baseDir) {
  // Match Obsidian wiki links: [[Note Name]] or [[Note Name|Alias]]
  const wikiLinkRegex = /\[\[([^\]]+)\]\]/g;
  
  return content.replace(wikiLinkRegex, (match, linkContent) => {
    const parts = linkContent.split('|');
    const noteName = parts[0].trim();
    const displayText = parts[1] ? parts[1].trim() : noteName;
    
    // Try to find the actual file
    const possiblePaths = [
      path.join(baseDir, noteName + '.md'),
      path.join(baseDir, noteName + '.md'),
      path.join(baseDir, noteName.replace(/\s+/g, ' ') + '.md'),
    ];
    
    // Also check subdirectories
    const findFile = (dir, fileName) => {
      try {
        const files = fs.readdirSync(dir, { withFileTypes: true });
        for (const file of files) {
          const fullPath = path.join(dir, file.name);
          if (file.isDirectory()) {
            const found = findFile(fullPath, fileName);
            if (found) return found;
          } else if (file.name.toLowerCase() === fileName.toLowerCase() + '.md') {
            return fullPath;
          }
        }
      } catch (err) {
        // Directory doesn't exist or can't be read
      }
      return null;
    };
    
    // Try to find the file
    let foundPath = null;
    for (const possiblePath of possiblePaths) {
      if (fs.existsSync(possiblePath)) {
        foundPath = possiblePath;
        break;
      }
    }
    
    if (!foundPath) {
      foundPath = findFile(vaultPath, noteName);
    }
    
    if (foundPath) {
      // Calculate relative path from vault root
      const relativePath = path.relative(vaultPath, foundPath);
      const linkPath = relativePath.replace(/\\/g, '/');
      return `[${displayText}](${linkPath})`;
    } else {
      // File not found, create a link anyway (Anytype will handle broken links)
      const safeName = noteName.replace(/\s+/g, ' ') + '.md';
      return `[${displayText}](${safeName})`;
    }
  });
}

/**
 * Recursively search for a file in a directory and its subdirectories
 * @param {string} searchDir - Directory to search in
 * @param {string} fileName - Name of the file to find
 * @param {number} maxDepth - Maximum depth to search (default: 10)
 * @param {number} currentDepth - Current depth (internal use)
 * @returns {string|null} Full path to the file if found, null otherwise
 */
function findFileRecursively(searchDir, fileName, maxDepth = 10, currentDepth = 0) {
  if (currentDepth >= maxDepth) {
    return null;
  }
  
  try {
    if (!fs.existsSync(searchDir)) {
      return null;
    }
    
    const entries = fs.readdirSync(searchDir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(searchDir, entry.name);
      
      // Skip hidden files and deleted items
      if (entry.name.startsWith('.') && entry.name !== '.') {
        continue;
      }
      
      if (isDeleted(fullPath, entry.name)) {
        continue;
      }
      
      if (entry.isFile()) {
        // Check if filename matches (case-insensitive)
        if (entry.name.toLowerCase() === fileName.toLowerCase()) {
          return fullPath;
        }
      } else if (entry.isDirectory()) {
        // Recursively search subdirectories
        const found = findFileRecursively(fullPath, fileName, maxDepth, currentDepth + 1);
        if (found) {
          return found;
        }
      }
    }
  } catch (err) {
    // Directory doesn't exist or can't be read
  }
  
  return null;
}

/**
 * Convert Obsidian image/embed syntax to standard markdown
 * Handles: ![[image.png]] and ![alt](path)
 * Sanitizes paths to match zip file paths (spaces -> underscores)
 * Paths are relative to vault root to match zip structure
 * Searches recursively in attachments folders and subfolders
 * @param {string} content - Markdown content
 * @param {string} fileDir - Full path to the directory containing the markdown file
 * @param {string} fileRelativeDir - Relative path from vault root to the directory (for zip structure)
 * @param {string} fileRelativePathInZip - Full relative path of the markdown file in zip (for calculating relative image paths)
 */
function convertImages(content, fileDir, fileRelativeDir = '', fileRelativePathInZip = '') {
  // Convert Obsidian embed syntax ![[image.png]] to standard markdown
  const embedRegex = /!\[\[([^\]]+)\]\]/g;
  
  let processedContent = content.replace(embedRegex, (match, imagePath) => {
    // Extract just the filename from the path
    const imageFileName = path.basename(imagePath);
    
    // Check if it's a relative path or absolute from vault
    let fullImagePath = path.isAbsolute(imagePath) 
      ? imagePath 
      : path.join(fileDir, imagePath);
    
    // Also try vault root
    if (!fs.existsSync(fullImagePath)) {
      fullImagePath = path.join(vaultPath, imagePath);
    }
    
    // Also try in attachments folder relative to current file
    if (!fs.existsSync(fullImagePath)) {
      const attachmentsPath = path.join(fileDir, 'attachments', imagePath);
      if (fs.existsSync(attachmentsPath)) {
        fullImagePath = attachmentsPath;
      }
    }
    
    // Also try attachments folder in vault root
    if (!fs.existsSync(fullImagePath)) {
      const attachmentsPath = path.join(vaultPath, 'attachments', imagePath);
      if (fs.existsSync(attachmentsPath)) {
        fullImagePath = attachmentsPath;
      }
    }
    
    // Recursively search in the file's directory and subdirectories first
    // This handles images in the same folder or nearby subfolders
    if (!fs.existsSync(fullImagePath)) {
      // Search in the file's directory and up to 3 levels deep
      const foundInFileDir = findFileRecursively(fileDir, imageFileName, 3, 0);
      if (foundInFileDir) {
        fullImagePath = foundInFileDir;
      }
    }
    
    // Recursively search in attachments folders if still not found
    if (!fs.existsSync(fullImagePath)) {
      // Try attachments folder relative to current file (recursive)
      const attachmentsDir = path.join(fileDir, 'attachments');
      if (fs.existsSync(attachmentsDir)) {
        const found = findFileRecursively(attachmentsDir, imageFileName);
        if (found) {
          fullImagePath = found;
        }
      }
    }
    
    // Try attachments folder in vault root (recursive)
    if (!fs.existsSync(fullImagePath)) {
      const attachmentsDir = path.join(vaultPath, 'attachments');
      if (fs.existsSync(attachmentsDir)) {
        const found = findFileRecursively(attachmentsDir, imageFileName);
        if (found) {
          fullImagePath = found;
        }
      }
    }
    
    // Try searching in the current file's directory and subdirectories (not just attachments)
    // This handles images in the same folder or subfolders as the markdown file
    if (!fs.existsSync(fullImagePath)) {
      // Search in the file's directory and up to 5 levels deep to find images in subfolders
      const foundInFileDir = findFileRecursively(fileDir, imageFileName, 5, 0);
      if (foundInFileDir) {
        fullImagePath = foundInFileDir;
      }
    }
    
    // Try searching in the root folder of the current file (e.g., SIGEO folder)
    // This handles images in the same root folder but different subfolders
    if (!fs.existsSync(fullImagePath)) {
      // Walk up to find the root folder (e.g., SIGEO)
      let currentDir = fileDir;
      let rootFolder = null;
      for (let i = 0; i < 10; i++) {
        const parentDir = path.dirname(currentDir);
        if (normalizePath(parentDir) === normalizePath(vaultPath)) {
          rootFolder = currentDir;
          break;
        }
        currentDir = parentDir;
      }
      
      if (rootFolder) {
        // Search in the root folder and its subdirectories
        const foundInRootFolder = findFileRecursively(rootFolder, imageFileName, 10, 0);
        if (foundInRootFolder) {
          fullImagePath = foundInRootFolder;
        }
      }
    }
    
    // Try searching in any attachments folder in the vault (recursive)
    if (!fs.existsSync(fullImagePath)) {
      const findAttachmentsFolders = (dir, maxDepth = 5, currentDepth = 0) => {
        if (currentDepth >= maxDepth) return null;
        
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const fullPath = path.join(dir, entry.name);
              const lowerName = entry.name.toLowerCase();
              
              // Check if this is an attachments folder
              if (lowerName === 'attachments' || lowerName === 'attachment' || lowerName.startsWith('attachments_')) {
                const found = findFileRecursively(fullPath, imageFileName);
                if (found) {
                  return found;
                }
              }
              
              // Recursively search subdirectories
              const subFound = findAttachmentsFolders(fullPath, maxDepth, currentDepth + 1);
              if (subFound) {
                return subFound;
              }
            }
          }
        } catch (err) {
          // Skip directories we can't read
        }
        return null;
      };
      
      const found = findAttachmentsFolders(vaultPath);
      if (found) {
        fullImagePath = found;
      }
    }
    
    // Final fallback: search entire vault recursively
    if (!fs.existsSync(fullImagePath)) {
      const foundInVault = findFileRecursively(vaultPath, imageFileName, 10, 0);
      if (foundInVault) {
        fullImagePath = foundInVault;
      }
    }
    
    if (fs.existsSync(fullImagePath)) {
      // Calculate path relative to vault root (for zip structure)
      const relativePath = path.relative(vaultPath, fullImagePath);
      let linkPath = relativePath.replace(/\\/g, '/');
      
      // Ensure path is always relative (not starting with ../)
      if (linkPath.startsWith('../')) {
        // If image is outside vault, keep original path but sanitize
        linkPath = imagePath;
      }
      
      // Sanitize path to match zip file paths (replace spaces with underscores)
      let sanitizedPath = sanitizePathForLink(linkPath);
      // Ensure path uses forward slashes (not backslashes) - critical for Anytype
      sanitizedPath = sanitizedPath.replace(/\\/g, '/');
      
      // Debug: log ALL image path resolution
      console.log(`    🖼️  Found image: ${imagePath} -> ${sanitizedPath} (file: ${path.basename(fullImagePath)})`);
      
      // Ensure the path matches exactly how it's stored in the zip
      // The path should be relative to vault root and sanitized
      return `![${path.basename(imagePath, path.extname(imagePath))}](${sanitizedPath})`;
    } else {
      // Debug: log when image is NOT found
      console.log(`    ⚠️  Image NOT found: ${imagePath} (searched from ${fileDir})`);
      // Image not found, but try to construct a valid path
      // If it's a relative path, make it relative to vault root
      let imagePathToUse = imagePath;
      if (!path.isAbsolute(imagePath) && !imagePath.startsWith('http://') && !imagePath.startsWith('https://')) {
        // Try to construct path relative to vault root
        const possiblePath = path.join(fileDir, imagePath);
        const relativeFromVault = path.relative(vaultPath, possiblePath);
        if (!relativeFromVault.startsWith('..')) {
          imagePathToUse = relativeFromVault.replace(/\\/g, '/');
        }
      }
      let sanitizedPath = sanitizePathForLink(imagePathToUse);
      // Ensure path uses forward slashes (not backslashes) - critical for Anytype
      sanitizedPath = sanitizedPath.replace(/\\/g, '/');
      return `![${path.basename(imagePath)}](${sanitizedPath})`;
    }
  });
  
  // Also sanitize paths in regular markdown image syntax ![alt](path)
  // This ensures all image paths match the sanitized paths in the zip
  const markdownImageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  processedContent = processedContent.replace(markdownImageRegex, (match, altText, imagePath) => {
    // Skip if it's already been processed (starts with http/https or is a data URI)
    if (imagePath.startsWith('http://') || imagePath.startsWith('https://') || imagePath.startsWith('data:')) {
      return match;
    }
    
    // Remove .md extension if incorrectly added to file path
    // Some markdown files might have file paths like "image.png.md" or "document.pdf.md" which is wrong
    let cleanImagePath = imagePath;
    if (cleanImagePath.toLowerCase().endsWith('.md')) {
      // Check if it's actually a file with .md incorrectly appended
      const withoutMd = cleanImagePath.slice(0, -3);
      // List of known file extensions (images, documents, etc.)
      const fileExts = [
        // Images
        '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.tiff', '.tif', '.heic', '.heif',
        // Documents
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
        // Audio/Video
        '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm',
        // Other
        '.zip', '.rar', '.7z', '.tar', '.gz', '.txt', '.csv', '.json', '.xml', '.html', '.css', '.js'
      ];
      if (fileExts.some(ext => withoutMd.toLowerCase().endsWith(ext))) {
        cleanImagePath = withoutMd;
      }
    }
    
    // Try to find the image file
    let fullImagePath = null;
    
    // If it's a relative path (starts with ./ or ../), resolve it relative to file directory
    if (cleanImagePath.startsWith('./') || cleanImagePath.startsWith('../')) {
      const resolvedFullPath = path.resolve(fileDir, cleanImagePath);
      if (fs.existsSync(resolvedFullPath)) {
        fullImagePath = resolvedFullPath;
      }
    } else if (!path.isAbsolute(cleanImagePath)) {
      // Relative path without ./ - try multiple locations
      const possiblePaths = [
        path.join(fileDir, cleanImagePath),
        path.join(vaultPath, cleanImagePath),
        path.join(fileDir, 'attachments', cleanImagePath),
        path.join(vaultPath, 'attachments', cleanImagePath)
      ];
      
      for (const possiblePath of possiblePaths) {
        if (fs.existsSync(possiblePath)) {
          fullImagePath = possiblePath;
          break;
        }
      }
      
      // If still not found, try recursive search in file's directory and subdirectories
      if (!fullImagePath) {
        const imageFileName = path.basename(cleanImagePath);
        
        // First, search in the file's directory and subdirectories (up to 5 levels)
        const foundInFileDir = findFileRecursively(fileDir, imageFileName, 5, 0);
        if (foundInFileDir) {
          fullImagePath = foundInFileDir;
        }
        
        // Then try attachments folder relative to current file
        if (!fullImagePath) {
          const attachmentsDir = path.join(fileDir, 'attachments');
          if (fs.existsSync(attachmentsDir)) {
            const found = findFileRecursively(attachmentsDir, imageFileName);
            if (found) {
              fullImagePath = found;
            }
          }
        }
        
        // Try vault root attachments folder if still not found
        if (!fullImagePath) {
          const vaultAttachmentsDir = path.join(vaultPath, 'attachments');
          if (fs.existsSync(vaultAttachmentsDir)) {
            const found = findFileRecursively(vaultAttachmentsDir, imageFileName);
            if (found) {
              fullImagePath = found;
            }
          }
        }
        
        // Finally, search in the root folder of the current file (e.g., SIGEO folder)
        if (!fullImagePath) {
          let currentDir = fileDir;
          let rootFolder = null;
          for (let i = 0; i < 10; i++) {
            const parentDir = path.dirname(currentDir);
            if (normalizePath(parentDir) === normalizePath(vaultPath)) {
              rootFolder = currentDir;
              break;
            }
            currentDir = parentDir;
          }
          
          if (rootFolder) {
            const foundInRootFolder = findFileRecursively(rootFolder, imageFileName, 10, 0);
            if (foundInRootFolder) {
              fullImagePath = foundInRootFolder;
            }
          }
        }
        
        // Last resort: search entire vault
        if (!fullImagePath) {
          const foundInVault = findFileRecursively(vaultPath, imageFileName, 10, 0);
          if (foundInVault) {
            fullImagePath = foundInVault;
          }
        }
      }
    } else {
      // Absolute path
      if (fs.existsSync(cleanImagePath)) {
        fullImagePath = cleanImagePath;
      }
    }
    
    // Calculate relative path from vault root and sanitize
    let resolvedPath = cleanImagePath;
    if (fullImagePath) {
      const relativeFromVault = path.relative(vaultPath, fullImagePath);
      if (!relativeFromVault.startsWith('..')) {
        resolvedPath = relativeFromVault.replace(/\\/g, '/');
      }
    }
    
    // Sanitize the path to match zip file paths
    let sanitizedPath = sanitizePathForLink(resolvedPath);
    // Ensure path uses forward slashes (not backslashes) - critical for Anytype
    sanitizedPath = sanitizedPath.replace(/\\/g, '/');
    
    // Debug: log markdown image path resolution
    if (fullImagePath) {
      console.log(`    🖼️  Found markdown image: ${imagePath} -> ${sanitizedPath} (file: ${path.basename(fullImagePath)})`);
    } else {
      console.log(`    ⚠️  Markdown image NOT found: ${imagePath} (in ${fileDir})`);
    }
    
    return `![${altText}](${sanitizedPath})`;
  });
  
  return processedContent;
}

/**
 * Normalize path for comparison
 */
function normalizePath(p) {
  return path.resolve(p).toLowerCase();
}

/**
 * Check if a directory is a root-level folder (direct child of root)
 */
function isRootLevelFolder(dirPath, rootPath = null) {
  const normalizedPath = normalizePath(dirPath);
  const effectiveRoot = rootPath || vaultPath;
  const normalizedRootPath = normalizePath(effectiveRoot);
  const parentDir = path.dirname(dirPath);
  const normalizedParentDir = normalizePath(parentDir);
  
  return normalizedParentDir === normalizedRootPath;
}

/**
 * Get the root Set that a directory belongs to (for exports)
 * Returns the root-level Set name, or null if not under any Set
 * ALL root-level folders are Sets (not just those with markdown files)
 */
function getRootSetForPathExport(dirPath, exportRootPath) {
  const normalizedPath = normalizePath(dirPath);
  const normalizedRootPath = normalizePath(exportRootPath);
  
  // If this is the export root, no Set
  if (normalizedPath === normalizedRootPath) {
    return null;
  }
  
  // If this is a root-level folder, it's a Set (if not deleted)
  if (isRootLevelFolder(dirPath, exportRootPath)) {
    const dirName = path.basename(dirPath);
    // All root folders are Sets, just check if not deleted
    if (!isDeleted(dirPath, dirName)) {
      return dirName;
    }
    return null;
  }
  
  // Otherwise, walk up to find the root-level folder
  let currentDir = dirPath;
  while (true) {
    const parentDir = path.dirname(currentDir);
    const normalizedParentDir = normalizePath(parentDir);
    
    if (normalizedParentDir === normalizedRootPath) {
      // Found the root-level folder
      const dirName = path.basename(currentDir);
      // All root folders are Sets, just check if not deleted
      if (!isDeleted(currentDir, dirName)) {
        return dirName;
      }
      return null;
    }
    
    currentDir = parentDir;
    
    // Safety check to avoid infinite loop
    if (normalizedPath === normalizePath(currentDir)) {
      break;
    }
  }
  
  return null;
}

/**
 * Get the root Set that a directory belongs to
 * Returns the root-level Set name, or null if not under any Set
 * ALL root-level folders are Sets (not just those with markdown files)
 */
function getRootSetForPath(dirPath) {
  return getRootSetForPathExport(dirPath, vaultPath);
}

/**
 * Get or create Set info for a directory path (for exports)
 * ALL root-level folders are Sets (regardless of markdown files)
 */
function getSetInfoForExport(dirPath, relativePath, exportRootPath) {
  const normalizedPath = normalizePath(dirPath);
  const cacheKey = `${normalizedPath}_${normalizePath(exportRootPath)}`;
  if (sets.has(cacheKey)) {
    return sets.get(cacheKey);
  }
  
  const dirName = path.basename(dirPath);
  const normalizedRootPath = normalizePath(exportRootPath);
  
  // Check if deleted (only check folder name, not path content)
  const lowerName = dirName.toLowerCase();
  if (lowerName === 'deleted' || lowerName === 'trash' || lowerName.startsWith('deleted_') || lowerName.startsWith('trash_')) {
    const setInfo = {
      name: dirName || 'Root',
      path: dirPath,
      relativePath: relativePath || '',
      isRootSet: false,
      rootSet: null,
      setFileName: relativePath ? `${relativePath.replace(/\\/g, '/')}/.set.md` : '.set.md',
      isDeleted: true
    };
    sets.set(cacheKey, setInfo);
    return setInfo;
  }
  
  // ALL root-level folders are Sets (not just those with markdown files)
  const isRootLevel = isRootLevelFolder(dirPath, exportRootPath);
  const isRootSet = isRootLevel;
  
  const setInfo = {
    name: dirName || 'Root',
    path: dirPath,
    relativePath: relativePath || '',
    isRootSet: isRootSet,
    rootSet: isRootSet ? dirName : getRootSetForPathExport(dirPath, exportRootPath),
    setFileName: relativePath ? `${relativePath.replace(/\\/g, '/')}/.set.md` : '.set.md',
    isDeleted: false
  };
  
  sets.set(cacheKey, setInfo);
  return setInfo;
}

/**
 * Get or create Set info for a directory path
 * ALL root-level folders are Sets (regardless of markdown files)
 */
function getSetInfo(dirPath, relativePath) {
  return getSetInfoForExport(dirPath, relativePath, vaultPath);
}

/**
 * Check if a directory has any markdown files (recursively)
 */
function hasMarkdownFilesInDir(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      
      // Skip hidden files, Set files, and deleted items
      if (entry.name.startsWith('.') && entry.name !== '.' && entry.name !== '.set.md') {
        continue;
      }
      
      if (entry.name === '.set.md') {
        continue;
      }
      
      if (isDeleted(fullPath, entry.name)) {
        continue;
      }
      
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.md' || ext === '.markdown') {
          // Verify file exists
          if (fs.existsSync(fullPath)) {
            return true;
          }
        }
      } else if (entry.isDirectory()) {
        // Recursively check subdirectories
        if (hasMarkdownFilesInDir(fullPath)) {
          return true;
        }
      }
    }
  } catch (err) {
    // If we can't read, assume no files
  }
  return false;
}

/**
 * Sanitize path for markdown links by replacing spaces with underscores
 * This ensures links work correctly in markdown
 */
function sanitizePathForLink(filePath) {
  // Normalize path separators to forward slashes first
  let normalizedPath = filePath.replace(/\\/g, '/');
  // Split path into components, replace spaces in each component, then rejoin
  const pathParts = normalizedPath.split('/');
  return pathParts.map(part => part.replace(/\s+/g, '_')).join('/');
}

/**
 * Build folder structure with heading hierarchy (h1, h2, h3, etc.)
 * Returns formatted content with headings for folders respecting folder path depth
 * headingLevel is the starting level (e.g., 2 for h2)
 * @param {string} dirPath - Full path to the directory
 * @param {string} vaultRootPath - Root path of the vault
 * @param {number} headingLevel - Starting heading level (default: 2 for h2)
 * @param {number} maxDepth - Maximum depth to traverse (default: 10)
 * @param {number} currentDepth - Current depth (internal use)
 * @param {string} relativePathPrefix - Relative path prefix for this directory in zip (for accurate link generation)
 */
function buildFolderStructure(dirPath, vaultRootPath, headingLevel = 2, maxDepth = 10, currentDepth = 0, relativePathPrefix = '') {
  if (currentDepth >= maxDepth) {
    return '';
  }
  
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const content = [];
    
    // Separate directories and files
    const directories = [];
    const files = [];
    
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      
      // Skip hidden files, Set files, and deleted items
      if (entry.name.startsWith('.') && entry.name !== '.' && entry.name !== '.set.md') {
        continue;
      }
      
      if (entry.name === '.set.md') {
        continue;
      }
      
      if (isDeleted(fullPath, entry.name)) {
        continue;
      }
      
      if (entry.isDirectory()) {
        directories.push(entry);
      } else if (entry.isFile() && shouldIncludeFile(fullPath)) {
        files.push(entry);
      }
    }
    
    // Sort for consistent output
    directories.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    
    // Add directories as headings
    for (const entry of directories) {
      const fullPath = path.join(dirPath, entry.name);
      const lowerName = entry.name.toLowerCase();
      
      // Skip attachments folders
      if (lowerName === 'attachments' || lowerName === 'attachment' || lowerName.startsWith('attachments_')) {
        continue;
      }
      
      // Calculate heading level based on actual folder depth from vault root
      // This ensures headings respect the folder path structure
      const folderRelativePath = path.relative(vaultRootPath, fullPath);
      const depth = folderRelativePath.split(path.sep).filter(p => p && p !== '.').length;
      const folderHeadingLevel = Math.min(headingLevel + depth - 1, 6); // Max h6, -1 because we want h2 for root folders
      
      // Create heading based on calculated depth
      const heading = '#'.repeat(folderHeadingLevel);
      content.push(`${heading} ${entry.name}\n`);
      
      // Calculate relative path prefix for subdirectory (matches how it's stored in zip)
      const subRelativePath = relativePathPrefix 
        ? path.join(relativePathPrefix, entry.name).replace(/\\/g, '/')
        : path.relative(vaultRootPath, fullPath).replace(/\\/g, '/');
      
      // Recursively add subdirectory structure
      const subContent = buildFolderStructure(fullPath, vaultRootPath, headingLevel, maxDepth, currentDepth + 1, subRelativePath);
      if (subContent) {
        content.push(subContent);
      }
    }
    
    // Add leaf files as links (only markdown files)
    for (const entry of files) {
      const ext = path.extname(entry.name).toLowerCase();
      
      // Only process markdown files (leaf pages)
      if (ext !== '.md' && ext !== '.markdown') {
        continue;
      }
      
      const fullPath = path.join(dirPath, entry.name);
      
      // Verify file exists and is actually a file (not a directory)
      if (!fs.existsSync(fullPath)) {
        continue;
      }
      
      try {
        const stats = fs.statSync(fullPath);
        if (!stats.isFile()) {
          continue;
        }
      } catch (err) {
        continue;
      }
      
      // Calculate relative path the same way files are added to zip
      // This ensures links match exactly how files are stored
      let fileRelativePath;
      if (relativePathPrefix) {
        // Use the same calculation as in processDirectory
        fileRelativePath = path.join(relativePathPrefix, entry.name).replace(/\\/g, '/');
      } else {
        // Fallback to relative from vault root
        fileRelativePath = path.relative(vaultRootPath, fullPath).replace(/\\/g, '/');
      }
      
      // Sanitize path for link (replace spaces with underscores) - matches zip file paths
      let sanitizedPath = sanitizePathForLink(fileRelativePath);
      // Ensure the path ends with .md (in case sanitization removed it)
      if (!sanitizedPath.toLowerCase().endsWith('.md') && !sanitizedPath.toLowerCase().endsWith('.markdown')) {
        sanitizedPath += ext;
      }
      // Ensure path uses forward slashes (not backslashes) - critical for Anytype
      sanitizedPath = sanitizedPath.replace(/\\/g, '/');
      const displayName = path.basename(entry.name, ext);
      // Use the sanitized path that matches exactly how the file is stored in the zip
      content.push(`- [${displayName}](${sanitizedPath})\n`);
    }
    
    return content.length > 0 ? content.join('') : '';
  } catch (err) {
    return '';
  }
}

/**
 * Create formatted page for folder structure
 * Uses heading hierarchy (h1, h2, h3) for folders and links to leaf pages
 */
function createSetFile(setInfo) {
  // Create a page (not a Set) with folder structure
  const frontmatter = {
    type: 'Page',
    name: setInfo.name
  };
  
  const frontmatterStr = '---\n' + 
    Object.entries(frontmatter)
      .map(([key, value]) => `${key}: ${typeof value === 'string' ? `"${value}"` : value}`)
      .join('\n') + 
    '\n---\n\n';
  
  // Build folder structure with heading hierarchy
  // Start with h1 for the root folder name
  let content = `# ${setInfo.name}\n\n`;
  
  // Build folder structure starting from h2 (subfolders)
  const folderStructure = buildFolderStructure(setInfo.path, setInfo.path, 2);
  
  if (folderStructure) {
    content += folderStructure;
  } else {
    content += `*No subfolders or pages found.*\n`;
  }
  
  return frontmatterStr + content;
}

/**
 * Check if a file path is directly in a root folder (not in a subfolder)
 * Compares the file's directory path with the vault root to determine if it's a root-level folder
 */
function isDirectlyInRootFolder(filePath) {
  if (!filePath) return false;
  try {
    const fileDir = path.dirname(filePath);
    const normalizedFileDir = normalizePath(fileDir);
    const normalizedVaultPath = normalizePath(vaultPath);
    
    // If file is in vault root, it's not in a root folder
    if (normalizedFileDir === normalizedVaultPath) {
      return false;
    }
    
    // Check if the file's directory is a root-level folder (direct child of vault)
    return isRootLevelFolder(fileDir, vaultPath);
  } catch (err) {
    return false;
  }
}

/**
 * Extract tags from markdown content
 * Handles Obsidian tags: #tag, #tag/subtag, #tag/subtag/subsubtag
 * Tags can appear at start of line, after whitespace, or standalone
 * @param {string} content - Markdown content
 * @returns {Array<string>} Array of unique tags
 */
function extractTags(content) {
  const tags = new Set();
  
  // Match Obsidian tags: #tag or #tag/subtag
  // Tags must be:
  // - At start of line, or after whitespace/punctuation (not part of a word)
  // - Followed by whitespace, punctuation, or end of line (not part of a word)
  // Tags can contain: alphanumeric, underscores, hyphens, and slashes
  // This regex ensures tags are standalone, not embedded in words
  const tagRegex = /(?:^|[\s\W])#([a-zA-Z0-9_\-/]+)(?=[\s\W]|$)/g;
  
  // Split content by code blocks to avoid matching tags in code
  const codeBlockRegex = /```[\s\S]*?```|`[^`]+`/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  
  // Extract non-code parts
  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(content.substring(lastIndex, match.index));
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    parts.push(content.substring(lastIndex));
  }
  
  // If no code blocks found, use entire content
  const textToSearch = parts.length > 0 ? parts.join('') : content;
  
  // Extract tags from non-code parts
  let tagMatch;
  // Reset regex lastIndex to ensure we search from the beginning
  tagRegex.lastIndex = 0;
  while ((tagMatch = tagRegex.exec(textToSearch)) !== null) {
    const tag = tagMatch[1];
    if (tag && tag.length > 0) {
      // Normalize tag (trim and ensure it's valid)
      const normalizedTag = tag.trim();
      if (normalizedTag.length > 0) {
        tags.add(normalizedTag);
      }
    }
  }
  
  return Array.from(tags).sort();
}

/**
 * Add Set and Page metadata to note content
 * Pages in folders use type "SetLeaf"
 * Root-level pages use type "Page"
 * Also extracts and adds tags to frontmatter
 */
function addPageMetadata(content, setInfo, filePath = null) {
  // Extract tags from content
  const tags = extractTags(content);
  
  // Debug: log tags found (only for files with tags)
  if (tags.length > 0 && filePath) {
    console.log(`    🏷️  Tags found in ${path.basename(filePath)}: ${tags.join(', ')}`);
  }
  
  // Check if frontmatter already exists
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
  const match = content.match(frontmatterRegex);
  
  // Determine type based on actual file path:
  // - SetLeaf if in any folder (has a rootSet)
  // - Page if root-level (no Set, file is in vault root)
  let pageType = 'Page';
  if (setInfo && setInfo.rootSet) {
    // All pages in folders use SetLeaf (removed setRoots type)
    pageType = 'SetLeaf';
  }
  
  if (match) {
    // Parse existing frontmatter
    const existingFrontmatter = match[1];
    let frontmatterObj = {};
    
    // Simple YAML parsing (basic key: value pairs)
    existingFrontmatter.split('\n').forEach(line => {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        let value = line.substring(colonIndex + 1).trim();
        // Remove quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) || 
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        frontmatterObj[key] = value;
      }
    });
    
    // Add type (SetLeaf for pages in Sets, Page for root pages) and root Set info
    frontmatterObj.type = pageType;
    if (setInfo && setInfo.rootSet) {
      frontmatterObj.set = setInfo.rootSet;
    }
    
    // Add tags if any found - format as objects
    if (tags.length > 0) {
      // If tags already exist in frontmatter, merge them
      let existingTags = [];
      if (frontmatterObj.tags) {
        if (Array.isArray(frontmatterObj.tags)) {
          existingTags = frontmatterObj.tags;
        } else if (typeof frontmatterObj.tags === 'object') {
          existingTags = Object.keys(frontmatterObj.tags);
        } else {
          existingTags = frontmatterObj.tags.split(',').map(t => t.trim());
        }
      }
      const allTags = [...new Set([...existingTags, ...tags])].sort();
      
      // Format tags as objects (key-value pairs where key and value are the same)
      const tagsObj = {};
      allTags.forEach(tag => {
        tagsObj[tag] = tag;
      });
      frontmatterObj.tags = tagsObj;
    }
    
    // Rebuild frontmatter
    const newFrontmatter = '---\n' + 
      Object.entries(frontmatterObj)
        .map(([key, value]) => {
          if (key === 'tags' && typeof value === 'object' && !Array.isArray(value)) {
            // Format tags as YAML object
            const tagEntries = Object.entries(value).map(([k, v]) => `  ${k}: "${v}"`).join('\n');
            return `${key}:\n${tagEntries}`;
          }
          return `${key}: ${typeof value === 'string' ? `"${value}"` : value}`;
        })
        .join('\n') + 
      '\n---\n';
    
    return content.replace(frontmatterRegex, newFrontmatter);
  } else {
    // Add new frontmatter
    const frontmatter = {
      type: pageType,
      ...(setInfo && setInfo.rootSet && { set: setInfo.rootSet })
    };
    if (tags.length > 0) {
      // Format tags as objects (key-value pairs where key and value are the same)
      const tagsObj = {};
      tags.forEach(tag => {
        tagsObj[tag] = tag;
      });
      frontmatter.tags = tagsObj;
    }
    
    const frontmatterStr = '---\n' + 
      Object.entries(frontmatter)
        .map(([key, value]) => {
          if (key === 'tags' && typeof value === 'object' && !Array.isArray(value)) {
            // Format tags as YAML object
            const tagEntries = Object.entries(value).map(([k, v]) => `  ${k}: "${v}"`).join('\n');
            return `${key}:\n${tagEntries}`;
          }
          return `${key}: ${typeof value === 'string' ? `"${value}"` : value}`;
        })
        .join('\n') + 
      '\n---\n\n';
    
    return frontmatterStr + content;
  }
}

/**
 * Process a markdown file and convert Obsidian-specific syntax
 * Pages directly in root folders become rootFolders type
 * Pages in subfolders become SetLeaf type
 * Root pages become Page type
 * @param {string} filePath - Full path to the markdown file
 * @param {object} setInfo - Set information for the file
 * @param {string} fileRelativeDir - Relative directory path from export root (for zip structure)
 */
function processMarkdownFile(filePath, setInfo, fileRelativeDir = '', fileRelativePathInZip = '') {
  const content = fs.readFileSync(filePath, 'utf-8');
  const fileDir = path.dirname(filePath);
  
  // Calculate the file's relative path from vault root (for zip structure)
  const fileRelativePath = path.relative(vaultPath, filePath);
  let calculatedRelativePathInZip = fileRelativePath.replace(/\\/g, '/');
  
  // If fileRelativePathInZip not provided, calculate it from vault root
  if (!fileRelativePathInZip) {
    fileRelativePathInZip = calculatedRelativePathInZip;
  }
  
  // If fileRelativeDir not provided, calculate it from vault root
  if (!fileRelativeDir) {
    fileRelativeDir = path.dirname(fileRelativePath) === '.' ? '' : path.dirname(fileRelativePath).replace(/\\/g, '/');
  }
  
  let processedContent = content;
  
  // Convert Obsidian links
  processedContent = convertObsidianLinks(processedContent, fileDir);
  
  // Convert images/embeds - pass fileRelativePathInZip for correct path calculation
  processedContent = convertImages(processedContent, fileDir, fileRelativeDir, fileRelativePathInZip);
  
  // Add metadata: rootFolders for pages directly in root folders, SetLeaf for subfolders, Page for root files
  // setInfo will be null for root files, or the Set info for files in folders
  processedContent = addPageMetadata(processedContent, setInfo, filePath);
  
  return processedContent;
}

/**
 * Check if a file or folder is marked as deleted
 * Only check explicit deletion markers, not just the word "deleted" in paths
 */
function isDeleted(filePath, name) {
  const lowerName = name.toLowerCase();
  
  // Only check if the name itself is explicitly "deleted" or "trash"
  // Don't check if the path contains these words (too aggressive)
  if (lowerName === 'deleted' || 
      lowerName === 'trash' ||
      lowerName.startsWith('deleted_') ||
      lowerName.startsWith('trash_') ||
      lowerName.endsWith('_deleted') ||
      lowerName.endsWith('_trash')) {
    return true;
  }
  
  // Check frontmatter for explicit deleted status (for markdown files)
  // Only check for exact matches, not just containing the word
  if (path.extname(filePath).toLowerCase() === '.md' || 
      path.extname(filePath).toLowerCase() === '.markdown') {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
      const match = content.match(frontmatterRegex);
      if (match) {
        const frontmatter = match[1];
        // Check for explicit deleted: true, status: deleted, etc.
        // Use regex to match whole key-value pairs
        if (/\bdeleted\s*:\s*(true|yes|1)\b/i.test(frontmatter) ||
            /\bstatus\s*:\s*deleted\b/i.test(frontmatter)) {
          return true;
        }
      }
    } catch (err) {
      // If we can't read the file, assume not deleted
    }
  }
  
  return false;
}

/**
 * Check if a directory contains markdown files (not just attachments)
 */
function hasMarkdownFiles(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      // Skip hidden files
      if (entry.name.startsWith('.') && entry.name !== '.') {
        continue;
      }
      
      // Skip deleted items
      if (isDeleted(path.join(dirPath, entry.name), entry.name)) {
        continue;
      }
      
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.md' || ext === '.markdown') {
          // Skip Set files
          if (entry.name !== '.set.md') {
            return true;
          }
        }
      } else if (entry.isDirectory()) {
        // Recursively check subdirectories
        if (hasMarkdownFiles(path.join(dirPath, entry.name))) {
          return true;
        }
      }
    }
  } catch (err) {
    // If we can't read the directory, assume no markdown files
  }
  return false;
}

/**
 * Check if a file should be included in the export
 */
function shouldIncludeFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  
  // Exclude deleted files
  if (isDeleted(filePath, name)) {
    return false;
  }
  
  // Exclude Obsidian-specific files
  const excludedFiles = ['.obsidian', '.trash', '.git'];
  const excludedExtensions = ['.obsidian', '.DS_Store'];
  
  // Check if in excluded directory
  for (const excluded of excludedFiles) {
    if (filePath.includes(path.sep + excluded + path.sep) || 
        filePath.includes(path.sep + excluded)) {
      return false;
    }
  }
  
  // Include markdown files and common attachment types
  const includedExtensions = [
    // Markdown
    '.md', '.markdown',
    // Images
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.tiff', '.tif', '.heic', '.heif',
    // Documents
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
    // Audio
    '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma',
    // Video
    '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm',
    // Archives
    '.zip', '.rar', '.7z', '.tar', '.gz',
    // Data
    '.txt', '.csv', '.json', '.xml', '.yaml', '.yml', '.toml',
    // Code (sometimes used as attachments)
    '.js', '.ts', '.py', '.java', '.cpp', '.c', '.h', '.html', '.css',
    // Other common files
    '.rtf', '.epub', '.mobi', '.azw', '.fb2'
  ];
  
  // Include files with known extensions
  if (includedExtensions.includes(ext)) {
    return true;
  }
  
  // For files without extensions or unknown extensions, include them as attachments
  // This ensures all attachment files are included, even with uncommon extensions
  // Only exclude if explicitly in the excluded list
  if (!excludedExtensions.some(e => name.includes(e))) {
    return true;
  }
  
  return false;
}

/**
 * Recursively process directory and add files to zip
 * Creates Sets for each folder level
 * Only leaf markdown files are marked as Pages
 * @param {string} dir - Directory to process
 * @param {object} zip - Zip archive object
 * @param {string} relativePath - Relative path for files in zip
 * @param {string} exportRootPath - Root path for this export (treats this as the vault root)
 */
function processDirectory(dir, zip, relativePath = '', exportRootPath = null) {
  try {
    // Use export root path if provided, otherwise use vault path
    const effectiveRootPath = exportRootPath || vaultPath;
    
    // Skip deleted directories entirely
    const dirName = path.basename(dir);
    if (isDeleted(dir, dirName)) {
      return;
    }
    
    // Get or create Set info for this directory
    // For exports, we need to check against the export root, not the vault root
    const setInfo = getSetInfoForExport(dir, relativePath, effectiveRootPath);
    
    // Create Set file for ALL root-level folders (not just those with markdown files)
    // Skip deleted folders
    const normalizedDir = normalizePath(dir);
    const normalizedVaultPath = normalizePath(vaultPath);
    
    const normalizedRootPath = normalizePath(effectiveRootPath);
    
    // Debug: log all root-level folder checks
    if (normalizedDir !== normalizedRootPath && isRootLevelFolder(dir, effectiveRootPath)) {
      console.log(`🔍 Checking root folder: ${setInfo.name} (isRootSet: ${setInfo.isRootSet}, isDeleted: ${setInfo.isDeleted})`);
    }
    
    // Don't create individual Set files for root folders
    // Only one "vault" Set file is created at the root level
    // Root folders are treated as subfolders in the vault Set
    
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    // Separate directories and files
    const directories = [];
    const files = [];
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      // Skip hidden files and Obsidian-specific directories
      if (entry.name.startsWith('.') && entry.name !== '.') {
        continue;
      }
      
      // Skip deleted items
      if (isDeleted(fullPath, entry.name)) {
        continue;
      }
      
      if (entry.isDirectory()) {
        directories.push(entry);
      } else if (entry.isFile() && shouldIncludeFile(fullPath)) {
        files.push(entry);
      }
    }
    
    // Process files first
    for (const entry of files) {
      const fullPath = path.join(dir, entry.name);
      const entryRelativePath = relativePath 
        ? path.join(relativePath, entry.name).replace(/\\/g, '/')
        : entry.name;
      
      // Sanitize path for zip (replace spaces with underscores)
      const sanitizedPath = sanitizePathForLink(entryRelativePath);
      
      const ext = path.extname(fullPath).toLowerCase();
      
      if (ext === '.md' || ext === '.markdown') {
        // Skip Set files (they're created separately)
        if (entry.name === '.set.md') {
          continue;
        }
        
        // Process markdown files as Pages
        // Determine Set info based on actual file path structure
        const normalizedDir = normalizePath(dir);
        const normalizedRootPath = normalizePath(effectiveRootPath);
        const normalizedVaultPath = normalizePath(vaultPath);
        
        // If file is in vault root (not in any folder), no Set info
        // Otherwise, use Set info for the directory
        let noteSetInfo = null;
        if (normalizedDir !== normalizedVaultPath) {
          // Always recalculate rootSet to ensure it's correct for nested folders
          // This is critical for subfolders and sub-subfolders
          const rootSet = getRootSetForPathExport(dir, effectiveRootPath);
          
          if (rootSet) {
            // Use the setInfo for this directory, but ensure rootSet is set correctly
            noteSetInfo = setInfo;
            
            // If setInfo doesn't exist or doesn't have the correct rootSet, update it
            if (!noteSetInfo) {
              noteSetInfo = getSetInfoForExport(dir, relativePath, effectiveRootPath);
            }
            
            // Always ensure rootSet is set correctly (in case it was missing or wrong)
            if (!noteSetInfo.rootSet || noteSetInfo.rootSet !== rootSet) {
              noteSetInfo.rootSet = rootSet;
              // Debug: log when we fix the rootSet
              if (noteSetInfo.rootSet !== rootSet) {
                console.log(`  🔧 Fixed rootSet for ${entry.name} in ${dir}: ${noteSetInfo.rootSet} -> ${rootSet}`);
              }
            }
          } else {
            // If no rootSet found, still use setInfo but log a warning
            noteSetInfo = setInfo;
            if (noteSetInfo && !noteSetInfo.rootSet) {
              console.log(`⚠️  Warning: No rootSet found for file ${entry.name} in ${dir} (relativePath: ${relativePath})`);
            }
          }
        }
        
        // Calculate the markdown file's relative directory and full path for image path resolution
        const markdownRelativeDir = entryRelativePath 
          ? path.dirname(entryRelativePath).replace(/\\/g, '/')
          : '';
        const markdownRelativePathInZip = sanitizedPath; // This is the sanitized path that will be used in zip
        
        const processedContent = processMarkdownFile(fullPath, noteSetInfo, markdownRelativeDir, markdownRelativePathInZip);
        zip.append(processedContent, { name: sanitizedPath });
        console.log(`  📄 Page: ${sanitizedPath}`);
      } else {
        // Copy all other files as-is (images, PDFs, attachments, etc.)
        // This includes all attachment files
        const fileContent = fs.readFileSync(fullPath);
        zip.append(fileContent, { name: sanitizedPath });
        // Log image files specifically for debugging
        const ext = path.extname(fullPath).toLowerCase();
        if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.tiff', '.tif', '.heic', '.heif'].includes(ext)) {
          console.log(`  🖼️  Image: ${sanitizedPath}`);
        } else {
          console.log(`  ✓ Attachment: ${sanitizedPath}`);
        }
      }
    }
    
    // Process subdirectories recursively
    for (const entry of directories) {
      const fullPath = path.join(dir, entry.name);
      const entryRelativePath = relativePath 
        ? path.join(relativePath, entry.name).replace(/\\/g, '/')
        : entry.name;
      
      // Sanitize path for consistency (replace spaces with underscores)
      const sanitizedRelativePath = sanitizePathForLink(entryRelativePath);
      
      processDirectory(fullPath, zip, sanitizedRelativePath, effectiveRootPath);
    }
  } catch (err) {
    console.error(`Error processing directory ${dir}:`, err.message);
  }
}

/**
 * Get the first markdown file in a folder (for creating links)
 */
function getFirstMarkdownFile(folderPath) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.md' || ext === '.markdown') {
          if (entry.name !== '.set.md' && !isDeleted(path.join(folderPath, entry.name), entry.name)) {
            return entry.name;
          }
        }
      } else if (entry.isDirectory()) {
        // Recursively check subdirectories
        const subPath = path.join(folderPath, entry.name);
        if (!isDeleted(subPath, entry.name)) {
          const found = getFirstMarkdownFile(subPath);
          if (found) {
            return path.join(entry.name, found);
          }
        }
      }
    }
  } catch (err) {
    // If we can't read, return null
  }
  return null;
}

/**
 * Create vault Set page with formatted folder structure
 * Uses heading hierarchy (h1, h2, h3) for folders respecting folder path depth
 */
function createVaultSetFile(rootFolders) {
  if (!rootFolders || rootFolders.length === 0) {
    console.error('⚠️  createVaultSetFile called with empty rootFolders array!');
    return '---\ntype: Set\nname: vault\n---\n\n# vault\n\n*No root folders found.*\n';
  }
  
  // Create a Set with folder structure
  const frontmatter = {
    type: 'Set',
    name: 'vault'
  };
  
  const frontmatterStr = '---\n' + 
    Object.entries(frontmatter)
      .map(([key, value]) => `${key}: ${typeof value === 'string' ? `"${value}"` : value}`)
      .join('\n') + 
    '\n---\n\n';
  
  // Build folder structure with heading hierarchy
  // Start with h1 for vault
  let content = `# vault\n\n`;
  
  // Add root folders as h2 headings with their structure
  const foldersNeedingEmptyFiles = [];
  console.log(`📋 Processing ${rootFolders.length} root folder(s) for vault Set...`);
  
  for (const folder of rootFolders) {
    if (!folder || !folder.name) {
      console.error('⚠️  Invalid folder in rootFolders:', folder);
      continue;
    }
    
    console.log(`  Processing folder: ${folder.name}`);
    
    // Build folder structure starting from h2 for root folders
    // The buildFolderStructure function will use proper heading levels based on depth
    // Calculate relative path prefix for this root folder (matches how it's stored in zip)
    const folderRelativePath = path.relative(vaultPath, folder.path).replace(/\\/g, '/');
    const folderStructure = buildFolderStructure(folder.path, vaultPath, 2, 10, 0, folderRelativePath);
    
    if (folderStructure) {
      content += folderStructure;
    } else {
      // If no markdown files found, create an empty .md file for this folder
      const firstFile = getFirstMarkdownFile(folder.path);
      if (!firstFile) {
        const emptyFileName = `${folder.name}.md`;
        // Calculate the full relative path from vault root
        const emptyFileFullPath = path.join(folder.path, emptyFileName);
        const relativePath = path.relative(vaultPath, emptyFileFullPath).replace(/\\/g, '/');
        const sanitizedPath = sanitizePathForLink(relativePath);
        // Ensure .md extension is included
        let filePath = sanitizedPath.toLowerCase().endsWith('.md') || sanitizedPath.toLowerCase().endsWith('.markdown') 
          ? sanitizedPath 
          : sanitizedPath + '.md';
        // Ensure path uses forward slashes (not backslashes) - critical for Anytype
        filePath = filePath.replace(/\\/g, '/');
        content += `## ${folder.name}\n\n- [${folder.name}](${filePath})\n\n`;
        foldersNeedingEmptyFiles.push({
          name: folder.name,
          path: folder.path,
          emptyFilePath: filePath,
          emptyFileName: emptyFileName
        });
        console.log(`    ⚠️  No markdown file found, will create empty: ${filePath}`);
      } else {
        // Calculate the full relative path from vault root
        const firstFileFullPath = path.join(folder.path, firstFile);
        const relativePath = path.relative(vaultPath, firstFileFullPath).replace(/\\/g, '/');
        const sanitizedPath = sanitizePathForLink(relativePath);
        // Ensure .md extension is included
        let filePath = sanitizedPath.toLowerCase().endsWith('.md') || sanitizedPath.toLowerCase().endsWith('.markdown') 
          ? sanitizedPath 
          : sanitizedPath + path.extname(firstFile);
        // Ensure path uses forward slashes (not backslashes) - critical for Anytype
        filePath = filePath.replace(/\\/g, '/');
        content += `## ${folder.name}\n\n- [${firstFile.replace(/\.md$/i, '')}](${filePath})\n\n`;
      }
    }
  }
  
  // Store folders needing empty files for later creation
  createVaultSetFile.foldersNeedingEmptyFiles = foldersNeedingEmptyFiles;
  
  return frontmatterStr + content;
}

/**
 * Main function to convert Obsidian vault to Anytype zip
 * Creates one zip with a root Set file containing all root folders
 */
function convertToAnytype() {
  // Check if vault path exists
  if (!fs.existsSync(vaultPath)) {
    console.error(`Error: Vault path does not exist: ${vaultPath}`);
    console.error('Usage: node to_anytype.js [vault_path] [output_path]');
    process.exit(1);
  }
  
  // Check if it's a directory
  const stats = fs.statSync(vaultPath);
  if (!stats.isDirectory()) {
    console.error(`Error: Vault path is not a directory: ${vaultPath}`);
    process.exit(1);
  }
  
  console.log(`Converting Obsidian vault: ${vaultPath}`);
  console.log(`Output: ${outputPath}`);
  console.log('---');
  
  // Find all root-level folders
  const rootFolders = [];
  try {
    const entries = fs.readdirSync(vaultPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = path.join(vaultPath, entry.name);
        
        // Skip hidden directories and deleted folders
        if (entry.name.startsWith('.') && entry.name !== '.') {
          continue;
        }
        
        if (isDeleted(fullPath, entry.name)) {
          continue;
        }
        
        // Skip attachments folders
        const lowerName = entry.name.toLowerCase();
        if (lowerName === 'attachments' || lowerName === 'attachment') {
          continue;
        }
        
        rootFolders.push({
          name: entry.name,
          path: fullPath
        });
      }
    }
  } catch (err) {
    console.error(`Error reading vault directory:`, err.message);
    process.exit(1);
  }
  
  if (rootFolders.length === 0) {
    console.log('No root folders found to export.');
    return;
  }
  
  console.log(`Found ${rootFolders.length} root folder(s):`);
  rootFolders.forEach((folder, index) => {
    console.log(`  ${index + 1}. ${folder.name}`);
  });
  console.log('');
  
  // Debug: verify root folders array
  if (rootFolders.length === 0) {
    console.log('⚠️  No root folders found!');
    return;
  }
  
  console.log(`📋 Root folders to include in root Set: ${rootFolders.map(f => f.name).join(', ')}`);
  console.log('');
  
  // Create zip file
  const output = createWriteStream(outputPath);
  const zip = archiver('zip', {
    zlib: { level: 9 } // Maximum compression
  });
  
  // Handle zip events
  output.on('close', () => {
    const sizeInMB = (zip.pointer() / 1024 / 1024).toFixed(2);
    console.log('---');
    console.log(`✓ Conversion complete!`);
    console.log(`  Total size: ${sizeInMB} MB`);
    console.log(`  Output file: ${outputPath}`);
  });
  
  zip.on('error', (err) => {
    console.error('Zip error:', err);
    process.exit(1);
  });
  
  // Pipe archive data to the file
  zip.pipe(output);
  
  // Create vault Set file containing all root folders with folder structure
  const vaultSetContent = createVaultSetFile(rootFolders);
  console.log(`📁 Creating vault Set with ${rootFolders.length} folder(s): ${rootFolders.map(f => f.name).join(', ')}`);
  zip.append(vaultSetContent, { name: 'vault.set.md' });
  console.log(`📁 Vault Set: vault.set.md`);
  
  // Create empty .md files for root folders that don't have markdown files
  if (createVaultSetFile.foldersNeedingEmptyFiles) {
    for (const folderInfo of createVaultSetFile.foldersNeedingEmptyFiles) {
      const emptyFileContent = `---\ntype: SetLeaf\nset: vault\n---\n\n# ${folderInfo.name}\n\nThis is the root folder: **${folderInfo.name}**\n`;
      zip.append(emptyFileContent, { name: folderInfo.emptyFilePath });
      console.log(`  📄 Created empty file: ${folderInfo.emptyFilePath}`);
    }
  }
  
  // Process each root folder (but don't create individual Set files for them)
  for (const folder of rootFolders) {
    const sanitizedFolderPath = sanitizePathForLink(folder.name);
    console.log(`\n📦 Processing: ${folder.name}`);
    processDirectory(folder.path, zip, sanitizedFolderPath, vaultPath);
  }
  
  // Process root-level attachment folders to ensure their files are included
  try {
    const entries = fs.readdirSync(vaultPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = path.join(vaultPath, entry.name);
        const lowerName = entry.name.toLowerCase();
        
        // Process attachment folders (but skip from rootFolders list)
        if (lowerName === 'attachments' || lowerName === 'attachment' || lowerName.startsWith('attachments_')) {
          // Skip if deleted
          if (isDeleted(fullPath, entry.name)) {
            continue;
          }
          
          // Process attachment folder to include all files
          const sanitizedFolderPath = sanitizePathForLink(entry.name);
          console.log(`\n📎 Processing attachments folder: ${entry.name}`);
          processDirectory(fullPath, zip, sanitizedFolderPath, vaultPath);
        }
      }
    }
  } catch (err) {
    console.error(`Error processing attachment folders:`, err.message);
  }
  
  // Finalize the archive
  zip.finalize();
}

// Run the conversion
if (require.main === module) {
  convertToAnytype();
}

module.exports = { convertToAnytype, processMarkdownFile };

