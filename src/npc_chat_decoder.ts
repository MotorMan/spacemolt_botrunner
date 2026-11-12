/**
 * Fibonacci Hex Decoder for NPC Chat Messages
 * 
 * Decodes hex strings using Fibonacci subtraction modulo 256
 * to produce English text messages.
 */

import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

export function decodeNpcChatHex(hexStr: string): string | null {
  // Validate input: hex string with reasonable length (even number of chars)
  if (!hexStr || hexStr.length < 20 || hexStr.length > 200 || hexStr.length % 2 !== 0) {
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
 * (hex string from "Unknown source")
 */
export function isEncodedNpcMessage(sender: string, content: string): boolean {
  const senderLower = sender.toLowerCase();
  if (!(senderLower === 'unknown source' || senderLower === 'unknown')) {
    return false;
  }
  
  // Extract potential hex from content (might have "source: " prefix or whitespace)
  const hexCandidate = content.trim().replace(/^source:\s*/i, '').replace(/\s+/g, '');
  
  return (
    hexCandidate.length >= 20 &&
    hexCandidate.length <= 200 &&
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

/**
 * Saved repeater message entry
 */
export interface RepeaterMessage {
  timestamp: string;        // ISO timestamp
  system: string;           // System where received
  poi: string;              // POI where received
  sender: string;           // Original sender (e.g., "Unknown source")
  channel: string;          // Chat channel
  hex: string;              // Original hex string
  decoded: string;          // Decoded text
}

/**
 * File path for repeater messages
 */
const REPEATER_MESSAGES_FILE = join(process.cwd(), "data", "repeaterMessages.json");

/**
 * Load existing repeater messages from disk
 */
function loadRepeaterMessages(): RepeaterMessage[] {
  try {
    if (existsSync(REPEATER_MESSAGES_FILE)) {
      const content = readFileSync(REPEATER_MESSAGES_FILE, "utf-8");
      return JSON.parse(content) as RepeaterMessage[];
    }
  } catch (err) {
    // Ignore parse errors, start fresh
  }
  return [];
}

/**
 * Save a decoded repeater message to disk
 */
export function saveRepeaterMessage(
  system: string,
  poi: string,
  sender: string,
  channel: string,
  hex: string,
  decoded: string
): void {
  try {
    const dir = join(process.cwd(), "data");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const messages = loadRepeaterMessages();
    
    // Extract clean hex for storage
    const cleanHex = extractHex(hex);
    
    const entry: RepeaterMessage = {
      timestamp: new Date().toISOString(),
      system,
      poi,
      sender,
      channel,
      hex: cleanHex,
      decoded,
    };

    messages.push(entry);
    
    // Keep only last 5000 messages to prevent unbounded growth
    const MAX_MESSAGES = 5000;
    const toSave = messages.slice(-MAX_MESSAGES);
    
    const payload = JSON.stringify(toSave, null, 2) + "\n";
    writeFileSync(REPEATER_MESSAGES_FILE, payload, "utf-8");
  } catch (err) {
    console.error("Failed to save repeater message:", err);
  }
}