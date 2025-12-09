/**
 * TagManager - Handles HTML tag masking and unmasking for translation
 * 
 * Masks HTML tags with XML-like placeholders before sending to AI translation,
 * then restores them afterward to preserve DOM structure and styling.
 * 
 * @example
 * const tm = new TagManager();
 * const { masked, tags } = tm.mask('<span class="red">Hello</span>');
 * // masked: '<x0>Hello</x0>'
 * // tags: ['<span class="red">', '</span>']
 * 
 * const restored = tm.unmask('<x0>Bonjour</x0>', tags);
 * // restored: '<span class="red">Bonjour</span>'
 */

const TagManager = {
  /**
   * Regex pattern to match all HTML tags:
   * - Opening tags: <tagname ...>
   * - Closing tags: </tagname>
   * - Self-closing tags: <tagname ... /> or <br>, <img>, etc.
   * 
   * Handles attributes with:
   * - Double quotes: class="value"
   * - Single quotes: class='value'
   * - Unquoted values: disabled
   * - Spaces within attribute values
   */
  TAG_REGEX: /<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s+[^>]*?)?\s*\/?>/g,

  /**
   * Self-closing HTML tags (void elements)
   */
  SELF_CLOSING_TAGS: new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
  ]),

  /**
   * Masks all HTML tags in the input string with sequential placeholders.
   * 
   * @param {string} html - The HTML string to mask
   * @returns {{ masked: string, tags: string[] }} Object containing:
   *   - masked: The string with tags replaced by placeholders
   *   - tags: Array of original tags indexed by placeholder number
   * 
   * Placeholder format:
   * - Opening tags: <xN> where N is the sequential index
   * - Closing tags: </xN> matching the corresponding opening tag
   * - Self-closing tags: <xN/>
   */
  mask(html) {
    if (typeof html !== 'string') {
      return { masked: '', tags: [] };
    }

    const tags = [];
    const tagStack = []; // Stack to track opening tags for matching closing tags
    
    const masked = html.replace(this.TAG_REGEX, (match) => {
      const isClosing = match.startsWith('</');
      const isSelfClosing = this._isSelfClosingTag(match);
      
      if (isClosing) {
        // Find the matching opening tag index from the stack
        const tagName = this._extractTagName(match);
        // Search from the end of the stack for the matching opening tag
        for (let i = tagStack.length - 1; i >= 0; i--) {
          if (tagStack[i].name === tagName) {
            const openingIndex = tagStack[i].index;
            tagStack.splice(i, 1); // Remove from stack
            tags.push(match);
            return `</x${openingIndex}>`;
          }
        }
        // No matching opening tag found, treat as standalone
        const index = tags.length;
        tags.push(match);
        return `</x${index}>`;
      } else if (isSelfClosing) {
        const index = tags.length;
        tags.push(match);
        return `<x${index}/>`;
      } else {
        // Opening tag
        const index = tags.length;
        const tagName = this._extractTagName(match);
        tagStack.push({ name: tagName, index });
        tags.push(match);
        return `<x${index}>`;
      }
    });

    return { masked, tags };
  },

  /**
   * Restores placeholders in translated text with original HTML tags.
   * 
   * @param {string} translated - The translated string containing placeholders
   * @param {string[]} tags - Array of original tags from mask()
   * @returns {string} The restored HTML string
   */
  unmask(translated, tags) {
    if (typeof translated !== 'string' || !Array.isArray(tags)) {
      return translated || '';
    }

    let result = translated;
    
    // Build a map of opening tag indices to their closing tag indices
    const closingTagMap = new Map();
    for (let i = 0; i < tags.length; i++) {
      if (tags[i].startsWith('</')) {
        // This is a closing tag, find its opening tag
        const tagName = this._extractTagName(tags[i]);
        // Search backwards for the matching opening tag
        for (let j = i - 1; j >= 0; j--) {
          if (!tags[j].startsWith('</') && this._extractTagName(tags[j]) === tagName && !closingTagMap.has(j)) {
            closingTagMap.set(j, i);
            break;
          }
        }
      }
    }
    
    // Replace all placeholder patterns with their corresponding tags
    // Match opening, closing, and self-closing placeholders
    result = result.replace(/<(\/?)x(\d+)(\/?)>/g, (match, isClosing, indexStr, isSelfClosing) => {
      const index = parseInt(indexStr, 10);
      
      if (isSelfClosing) {
        // Self-closing placeholder: <xN/>
        if (index >= 0 && index < tags.length) {
          return tags[index];
        }
      } else if (isClosing) {
        // Closing placeholder: </xN> - look up the closing tag for opening tag at index
        const closingIndex = closingTagMap.get(index);
        if (closingIndex !== undefined && closingIndex < tags.length) {
          return tags[closingIndex];
        }
        // Fallback: try to find a closing tag directly
        if (index >= 0 && index < tags.length) {
          return tags[index];
        }
      } else {
        // Opening placeholder: <xN>
        if (index >= 0 && index < tags.length) {
          return tags[index];
        }
      }
      
      // If index is out of bounds, return the placeholder as-is
      return match;
    });

    return result;
  },

  /**
   * Validates that placeholders in translated text match expected pattern and count.
   * 
   * @param {string} translated - The translated string to validate
   * @param {number} expectedCount - Expected number of unique placeholder indices
   * @returns {boolean} True if placeholders are valid, false otherwise
   */
  validatePlaceholders(translated, expectedCount) {
    if (typeof translated !== 'string') {
      return false;
    }

    // Find all placeholder indices used
    const placeholderRegex = /<\/?x(\d+)\/?>/g;
    const usedIndices = new Set();
    let match;

    while ((match = placeholderRegex.exec(translated)) !== null) {
      const index = parseInt(match[1], 10);
      usedIndices.add(index);
      
      // Check if index is within expected range
      if (index < 0 || index >= expectedCount) {
        return false;
      }
    }

    return true;
  },

  /**
   * Strips all HTML tags and placeholders, returning plain text.
   * Used as a fallback when placeholder restoration fails.
   * 
   * @param {string} text - The text to strip
   * @returns {string} Plain text content
   */
  stripToPlainText(text) {
    if (typeof text !== 'string') {
      return '';
    }

    // Remove placeholders first
    let result = text.replace(/<\/?x\d+\/?>/g, '');
    
    // Remove HTML tags
    result = result.replace(/<[^>]*>/g, '');
    
    // Normalize whitespace
    result = result.replace(/\s+/g, ' ').trim();

    return result;
  },

  /**
   * Extracts the tag name from an HTML tag string.
   * @private
   */
  _extractTagName(tag) {
    const match = tag.match(/<\/?([a-zA-Z][a-zA-Z0-9]*)/);
    return match ? match[1].toLowerCase() : '';
  },

  /**
   * Determines if a tag is self-closing.
   * @private
   */
  _isSelfClosingTag(tag) {
    // Check for explicit self-closing syntax: <tag />
    if (/\/\s*>$/.test(tag) && !tag.startsWith('</')) {
      return true;
    }
    
    // Check for void elements (HTML5 self-closing tags)
    const tagName = this._extractTagName(tag);
    return this.SELF_CLOSING_TAGS.has(tagName);
  }
};

// Export for ES modules (Node.js/Jest) and browser environments
// For browser content scripts, TagManager is already a global object
// For ES modules (testing), we export it
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TagManager };
} else if (typeof window !== 'undefined') {
  window.TagManager = TagManager;
}

export { TagManager };
