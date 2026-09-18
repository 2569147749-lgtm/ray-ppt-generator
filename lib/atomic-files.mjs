import { existsSync } from "node:fs";
import { copyFile, rename, rm, writeFile } from "node:fs/promises";

export async function atomicWriteFiles(entries) {
  const token = `${process.pid}-${Date.now()}`;
  const prepared = [];
  const committed = [];
  const paths = new Set();

  try {
    for (const entry of entries) {
      if (paths.has(entry.path)) {
        throw new Error(`Duplicate atomic destination: ${entry.path}`);
      }
      paths.add(entry.path);
      const temporary = `${entry.path}.${token}.tmp`;
      if (entry.source) await copyFile(entry.source, temporary);
      else await writeFile(temporary, entry.content, "utf8");
      prepared.push({
        ...entry,
        temporary,
        backup: `${entry.path}.${token}.bak`,
        existed: existsSync(entry.path)
      });
    }

    for (const entry of prepared) {
      if (entry.existed) await rename(entry.path, entry.backup);
      await rename(entry.temporary, entry.path);
      committed.push(entry);
    }

    for (const entry of prepared) {
      if (entry.existed) await rm(entry.backup, { force: true });
    }
  } catch (error) {
    for (const entry of [...committed].reverse()) {
      await rm(entry.path, { force: true });
    }
    for (const entry of [...prepared].reverse()) {
      if (entry.existed && existsSync(entry.backup)) {
        await rename(entry.backup, entry.path);
      }
      await rm(entry.temporary, { force: true });
    }
    throw error;
  }
}

export async function atomicWriteTextFiles(entries) {
  return atomicWriteFiles(entries);
}
