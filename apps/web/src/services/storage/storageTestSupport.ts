/** Shared fakes for Storage/Database service unit tests (not app code). */

import type { DatabaseInfo } from "../../shared/contracts";
import { createMemoryMetadataStore } from "./metadataDb";
import { dbFileName } from "./reconcile";
import type { StorageWorker } from "./storageService";

export class FakeStorageWorker implements StorageWorker {
  activeFilename: string | null = null;
  readonly files = new Set<string>();
  failOpen = false;
  failDelete = false;

  async listFiles(): Promise<string[]> {
    return [...this.files];
  }

  async deleteFile(filename: string): Promise<{ existed: boolean }> {
    if (this.failDelete) throw new Error("disk on fire");
    const existed = this.files.delete(filename);
    if (this.activeFilename === filename) this.activeFilename = null;
    return { existed };
  }

  async openFile(filename: string): Promise<number> {
    if (this.failOpen) throw new Error("cannot open");
    this.files.add(filename);
    this.activeFilename = filename;
    return 8192;
  }
}

export function makeEntry(overrides: Partial<DatabaseInfo> = {}): DatabaseInfo {
  return {
    id: "id-1",
    name: "Database",
    createdAt: 1,
    lastOpenedAt: 1,
    sizeBytes: 0,
    status: "ok",
    ...overrides,
  };
}

export function makeStore(seed: DatabaseInfo[] = []) {
  return createMemoryMetadataStore(seed);
}

export { dbFileName };
