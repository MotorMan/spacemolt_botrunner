/**
 * Fibonacci Hex Decoder for NPC Chat Messages
 * 
 * Decodes 134-char hex strings (67 bytes) using Fibonacci subtraction modulo 256
 * to produce 66-char English text messages.
 */

export function decodeNpcChatHex(hexStr: string): string | null {
  // Validate input: should be 134 hex chars (67 bytes) but we handle 132 (66 bytes) too
  if (!hexStr || hexStr.length < 130 || hexStr.length > 136 || hexStr.length % 2 !== 0) {
    return null;
  }

  // Check if it's a valid hex string
  if (!/^[0-9a-fA-F]+$/.test(hexStr)) {
    return null;
  }

  try {
    // Step 1: Convert hex to bytes
    const bytes = Buffer.from(hexStr, 'hex');
    
    // Step 2: Generate Fibonacci sequence (mod 256)
    const fib: number[] = [1, 1];
    while (fib.length < bytes.length) {
      fib.push((fib[fib.length - 1] + fib[fib.length - 2]) % 256);
    }

    // Step 3: Subtract Fibonacci numbers modulo 256
    const decoded = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      decoded[i] = (bytes[i] - fib[i] + 256) % 256;
    }

    // Step 4: Convert to string, handling non-printable chars
    let result = '';
    for (const byte of decoded) {
      if (byte >= 32 && byte <= 126) {
        result += String.fromCharCode(byte);
      } else {
        // Non-printable character - could be padding or corruption
        // We'll include a placeholder or skip
        result += '�';
      }
    }

    // Clean up: remove trailing replacement chars and whitespace
    result = result.replace(/�+$/, '').trim();
    
    // Only return if we got reasonable English text (at least 20 printable chars)
    const printableMatches = result.match(/[A-Za-z0-9\s.,!?']/g);
    const printableCount = printableMatches ? printableMatches.length : 0;
    if (printableCount < 20) {
      return null;
    }

    return result;
  } catch (err) {
    return null;
  }
}

/**
 * Check if a message content looks like an encoded NPC chat message
 * (134-char hex string from "Unknown source")
 */
export function isEncodedNpcMessage(sender: string, content: string): boolean {
  const senderLower = sender.toLowerCase();
  if (!(senderLower === 'unknown source' || senderLower === 'unknown')) {
    return false;
  }
  
  // Extract potential hex from content (might have "source: " prefix or whitespace)
  const hexCandidate = content.trim().replace(/^source:\s*/i, '').replace(/\s+/g, '');
  
  return (
    hexCandidate.length >= 130 &&
    hexCandidate.length <= 136 &&
    hexCandidate.length % 2 === 0 &&
    /^[0-9a-fA-F]+$/.test(hexCandidate)
  );
}

/**
 * Extract clean hex string from content
 */
function extractHex(content: string): string {
  return content.trim().replace(/^source:\s*/i, '').replace(/\s+/g, '');
}

/**
 * Try to decode a message if it matches the encoded NPC pattern
 * Returns the decoded text if successful, null otherwise
 */
export function tryDecodeNpcMessage(sender: string, content: string): string | null {
  if (!isEncodedNpcMessage(sender, content)) {
    return null;
  }
  const hexStr = extractHex(content);
  return decodeNpcChatHex(hexStr);
}