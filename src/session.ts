import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export interface Credentials {
  username: string;
  password: string;
  empire: string;
  playerId: string;
}

export interface SessionToken {
  sessionId: string;
  expiresAt?: string; // Kept for debugging, not used for validation
  playerId?: string;
  v2SessionId?: string;
  v2ExpiresAt?: string; // Kept for debugging, not used for validation
}

export class SessionManager {
  readonly dir: string;
  private credentialsPath: string;
  private legacyCredentialsPath: string;
  private todoPath: string;
  private sessionTokenPath: string;

  constructor(sessionName: string, baseDir: string) {
    this.dir = join(baseDir, "sessions", sessionName);
    this.credentialsPath = join(this.dir, "credentials.json");
    this.legacyCredentialsPath = join(this.dir, "CREDENTIALS.md");
    this.todoPath = join(this.dir, "TODO.md");
    this.sessionTokenPath = join(this.dir, "session.json");
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  loadCredentials(): Credentials | null {
    // Try JSON first
    if (existsSync(this.credentialsPath)) {
      try {
        const data = JSON.parse(readFileSync(this.credentialsPath, "utf-8"));
        if (data.username && data.password) {
          return {
            username: data.username,
            password: data.password,
            empire: data.empire || "",
            playerId: data.playerId || data.player_id || "",
          };
        }
      } catch {}
    }
    // Fall back to legacy markdown format
    if (existsSync(this.legacyCredentialsPath)) {
      const creds = this.parseLegacyCredentials(
        readFileSync(this.legacyCredentialsPath, "utf-8")
      );
      if (creds) {
        // Migrate to JSON
        this.saveCredentials(creds);
        return creds;
      }
    }
    return null;
  }

  private parseLegacyCredentials(text: string): Credentials | null {
    const get = (label: string): string => {
      const match = text.match(new RegExp(`- ${label}:\\s*(.+)`, "i"));
      return match ? match[1].trim() : "";
    };
    const username = get("Username");
    const password = get("Password");
    const empire = get("Empire");
    const playerId = get("Player ID");
    if (!username || !password) return null;
    return { username, password, empire, playerId };
  }

  saveCredentials(creds: Credentials): void {
    writeFileSync(
      this.credentialsPath,
      JSON.stringify(creds, null, 2) + "\n",
      "utf-8"
    );
  }

  saveSessionToken(token: SessionToken): void {
    writeFileSync(
      this.sessionTokenPath,
      JSON.stringify(token, null, 2) + "\n",
      "utf-8"
    );
  }

  loadSessionToken(): SessionToken | null {
    if (!existsSync(this.sessionTokenPath)) return null;
    try {
      const data = JSON.parse(readFileSync(this.sessionTokenPath, "utf-8"));
      if (data.sessionId && data.expiresAt) {
        return data as SessionToken;
      }
    } catch {}
    return null;
  }

  clearSessionToken(): void {
    if (existsSync(this.sessionTokenPath)) {
      writeFileSync(this.sessionTokenPath, "{}\n", "utf-8");
    }
  }

  loadTodo(): string {
    if (!existsSync(this.todoPath)) return "";
    return readFileSync(this.todoPath, "utf-8");
  }

  saveTodo(content: string): void {
    writeFileSync(this.todoPath, content, "utf-8");
  }
}
