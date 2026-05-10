// ── Rescue Coordination ────────────────────────────────────
/**
 * Tracks rescue operations announced in faction chat to prevent
 * multiple bots from responding to the same MAYDAY/request.
 */

export interface RescueAnnouncement {
  rescuerUsername: string;
  targetName: string;
  targetSystem: string;
  targetPoi?: string;
  timestamp: number;
  isMayday: boolean;
}

const announcedRescues: RescueAnnouncement[] = [];

// Track announcements we've already seen and logged (prevents repeated logging)
// Key format: "${rescuerUsername}|${targetName}|${targetSystem}"
const seenAnnouncements = new Set<string>();

// Consider a rescue "active" for 10 minutes (600000 ms)
// After that, assume it completed or failed
const RESCUE_ACTIVE_MS = 600000;
const ANNOUNCEMENT_SEEN_TTL_MS = 300000; // 5 minutes - announcements stay "seen" for 5 minutes

/**
 * Record a rescue announcement from faction chat.
 * Returns true if this is a new announcement we haven't seen before,
 * false if we already processed/saw this announcement.
 */
export function recordRescueAnnouncement(announcement: RescueAnnouncement): boolean {
  // Check if we've already seen this announcement (prevent repeated logging)
  const seenKey = `${announcement.rescuerUsername}|${announcement.targetName}|${announcement.targetSystem}`;
  if (seenAnnouncements.has(seenKey)) {
    return false; // Already seen this one
  }
  
  // Mark as seen
  seenAnnouncements.add(seenKey);
  
  // Now record it
  announcedRescues.push(announcement);
  
  // Clean up old entries (keep last 50)
  if (announcedRescues.length > 50) {
    announcedRescues.shift();
  }
  
  return true; // New announcement
}

/**
 * Clear a seen announcement (when the rescue is completed or failed).
 * This allows the same player/system to be announced again for a new rescue.
 */
export function clearSeenAnnouncement(targetName: string, targetSystem: string): void {
  for (const rescuer of seenAnnouncements) {
    const parts = rescuer.split('|');
    if (parts.length >= 2 && parts[1] === targetName && parts[2] === targetSystem) {
      seenAnnouncements.delete(rescuer);
    }
  }
}

/**
 * Check if we've already seen this announcement (for conditional logging).
 */
export function haveSeenAnnouncement(rescuerUsername: string, targetName: string, targetSystem: string): boolean {
  const seenKey = `${rescuerUsername}|${targetName}|${targetSystem}`;
  return seenAnnouncements.has(seenKey);
}

/**
 * Check if a rescue target is already being handled by another bot.
 * Returns the announcement if found, null otherwise.
 */
export function isRescueHandled(
  targetName: string,
  targetSystem: string,
  targetPoi?: string,
  excludeRescuer?: string
): RescueAnnouncement | null {
  const now = Date.now();
  
  // Normalize for comparison (handle spaces, underscores, capitalization)
  const normalize = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  
  for (const announcement of announcedRescues) {
    // Skip expired announcements
    if (now - announcement.timestamp > RESCUE_ACTIVE_MS) {
      continue;
    }
    
    // Skip announcements from this bot
    if (excludeRescuer && announcement.rescuerUsername === excludeRescuer) {
      continue;
    }
    
    // Check if this matches the target
    const nameMatch = normalize(announcement.targetName) === normalize(targetName);
    const systemMatch = normalize(announcement.targetSystem) === normalize(targetSystem);
    
    // POI matching is optional - if we don't have a POI, just match on name+system
    const poiMatch = !targetPoi || !announcement.targetPoi || 
                     normalize(announcement.targetPoi) === normalize(targetPoi);
    
    if (nameMatch && systemMatch && poiMatch) {
      return announcement;
    }
  }
  
  return null;
}

/**
 * Parse a faction chat message for rescue announcements.
 * Returns a RescueAnnouncement if found, null otherwise.
 * 
 * Expected formats (LLM-generated, so quite varied):
 * - "[Rescuer] here — responding to [Target]'s MAYDAY in [Location]"
 * - "[Rescuer] here — responding to MAYDAY from [Target] in [Location]"
 * - "Launching rescue mission for [targetName] at [system]/[poi]"
 * - "Rescue operation for [targetName] in [system]"
 * - "Going to rescue [targetName] at [system]"
 */
export function parseRescueAnnouncement(
  content: string,
  sender: string,
  timestamp: number
): RescueAnnouncement | null {
  const contentLower = content.toLowerCase();
  
  // Check if this looks like a rescue announcement
  const rescueKeywords = [
    'rescue mission',
    'launching rescue',
    'responding to mayday',
    'rescue operation',
    'going to rescue',
    'helping',
    'fuel rescue',
    "here — responding to",
    "here - responding to"
  ];
  
  if (!rescueKeywords.some(kw => contentLower.includes(kw))) {
    return null;
  }
  
  let targetName: string | null = null;
  let targetSystem: string | null = null;
  let targetPoi: string | undefined;
  
  // Pattern 1: "[Rescuer] here — responding to [Target]'s MAYDAY in [Location]"
  // Example: "Ultima Good here — responding to CaptJack's MAYDAY in Market Prime Exchange"
  const possessiveMaydayPattern = /responding to\s+([a-z0-9_\-\.]+)'s\s+mayday\s+(?:in|at)\s+([a-z0-9_\s\-]+)/i;
  let match = content.match(possessiveMaydayPattern);
  if (match) {
    targetName = match[1];
    const location = match[2];
    // Location is the system/POI name
    targetSystem = location.trim();
  }
  
  // Pattern 2: "[Rescuer] here — responding to MAYDAY from [Target] in [Location]"
  // Example: "Xana Rich here — responding to MAYDAY from Xerxes in Alfirk Star"
  if (!targetName) {
    const fromMaydayPattern = /responding to\s+mayday\s+from\s+([a-z0-9_\-\.]+)\s+(?:in|at)\s+([a-z0-9_\s\-]+)/i;
    match = content.match(fromMaydayPattern);
    if (match) {
      targetName = match[1];
      targetSystem = match[2].trim();
    }
  }
  
  // Pattern 3: "for [name] at [system]" or "for [name] in [system]"
  // Example: "Launching rescue mission for Peon7 at Sol / Sol Station"
  if (!targetName) {
    const forAtPattern = /for\s+([a-z0-9_\-\.]+)\s+(?:at|in)\s+([a-z0-9_\s\-/]+)/i;
    match = content.match(forAtPattern);
    if (match) {
      targetName = match[1];
      // Location might include POI (e.g., "Sol / Sol Station")
      const location = match[2];
      const parts = location.split('/').map(s => s.trim());
      targetSystem = parts[0];
      targetPoi = parts[1];
    }
  }
  
  if (!targetName || !targetSystem) {
    return null;
  }
  
  // Check if it's a MAYDAY
  const isMayday = contentLower.includes('mayday');
  
  return {
    rescuerUsername: sender,
    targetName: targetName.trim(),
    targetSystem: targetSystem.trim(),
    targetPoi: targetPoi?.trim(),
    timestamp,
    isMayday,
  };
}

/**
 * Clean up expired rescue announcements.
 */
export function cleanupExpiredAnnouncements(): void {
  const now = Date.now();
  const initialLength = announcedRescues.length;
  
  const valid = announcedRescues.filter(a => now - a.timestamp < RESCUE_ACTIVE_MS);
  
  if (valid.length < initialLength) {
    announcedRescues.length = 0;
    announcedRescues.push(...valid);
  }
  
  // Also clean up expired "seen" announcements (older than ANNOUNCEMENT_SEEN_TTL_MS)
  // These are tracked separately from the announcements array
  // We iterate through and check timestamps in the announcements array
  const expiredKeys: string[] = [];
  for (const seenKey of seenAnnouncements) {
    const parts = seenKey.split('|');
    if (parts.length >= 3) {
      const [, targetName, targetSystem] = parts;
      // Find this announcement in the array
      const announcement = announcedRescues.find(a => 
        a.targetName === targetName && a.targetSystem === targetSystem
      );
      if (announcement && now - announcement.timestamp > ANNOUNCEMENT_SEEN_TTL_MS) {
        expiredKeys.push(seenKey);
      }
    }
  }
  
  // Remove expired keys
  for (const key of expiredKeys) {
    seenAnnouncements.delete(key);
  }
}

/**
 * Get all active rescue announcements (for debugging).
 */
export function getActiveRescueAnnouncements(): RescueAnnouncement[] {
  const now = Date.now();
  return announcedRescues.filter(a => now - a.timestamp < RESCUE_ACTIVE_MS);
}
