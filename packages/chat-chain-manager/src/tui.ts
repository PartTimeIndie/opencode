import { createReadLineInterface } from '@opentui/core';
import { getChatChainConfig, setChatChainConfig } from './index';

export interface ChatChainConfig {
  chain: string[];
  limitMessage: string;
  source: string;
}

/**
 * Holt die aktuelle Chat-Ketten-Konfiguration aus ~/.config/opencode/chat-chain.json
 */
export async function getCurrentConfig(): Promise<ChatChainConfig> {
  return getChatChainConfig();
}

/**
 * Speichert eine neue Chat-Ketten-Konfiguration
 * Schreibt nach ~/.config/opencode/chat-chain.json (atomar)
 */
export async function setConfig(chain: string[], limitMessage: string): Promise<void> {
  const fs = await import('fs');
  const pathModule = await import('path');
  const os = await import('os');

  const configPath = pathModule.join(os.homedir(), '.config', 'opencode', 'chat-chain.json');
  const config = { chain, limitMessage };

  // Atomare Schreibweise: temporäre Datei + rename
  const temporaryPath = configPath + '.' + process.pid + '.tmp';
  await fs.promises.writeFile(temporaryPath, JSON.stringify(config, null, 2));
  await fs.promises.rename(temporaryPath, configPath);
}

/**
 * CLI / TUI Eintrittspunkt für die Chat-Ketten-Verwaltung
 */
export async function main(): Promise<void> {
  try {
    const config = await getCurrentConfig();

    const readline = await createReadLineInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'chat-chain> ',
    });

    console.log('\nChat-Ketten-Konfiguration:');
    console.log('  Kette:', config.chain.join(' → '));
    console.log('  Limit-Nachricht:', config.limitMessage);
    console.log('  Quelle:', config.source);
    console.log();

    const questions: string[] = [
      'Befehle:',
      '  kette <kette>  - Kette setzen (durch Komma trennen, z.B. glm-5.3,gpt-5.6-sol:medium)',
      '  nachricht <t>  - Limit-Nachricht setzen',
      '  anzeigen        - Konfiguration neu laden und anzeigen',
      '  verlassen        - Programm verlassen',
    ];

    for (const q of questions) {
      console.log(q);
    }
    console.log();

    while (true) {
      const line = await readline!.question('> ');
      const parts = line.trim().split(/\s+/);
      const cmd = parts[0]?.toLowerCase();

      if (cmd === 'verlassen' || cmd === 'exit' || cmd === 'quit') {
        console.log('Tschüss!');
        readline.close();
        return;
      }

      if (cmd === 'anzeigen') {
        const c = await getChatChainConfig();
        console.log('\n--- Aktuelle Konfiguration ---');
        console.log('Kette:', c.chain.join(' → '));
        console.log('Limit-Nachricht:', c.limitMessage);
        console.log('Quelle:', c.source);
        console.log('----------------------------');
        readline.prompt();
        continue;
      }

      if (cmd === 'kette' && parts[1]) {
        const newChain = parts[1].split(',').map((s: string) => s.trim()).filter((s: string) => s.length > 0);
        await setConfig(newChain, config.limitMessage);
        console.log('✓ Kette aktualisiert:', newChain.join(' → '));
        const c2 = await getChatChainConfig();
        console.log('Neue Kette:', c2.chain.join(' → '));
        readline.prompt();
        continue;
      }

      if (cmd === 'nachricht' && parts[1]) {
        await setConfig(config.chain, parts[1]);
        console.log('✓ Limit-Nachricht aktualisiert:', parts[1]);
        const c2 = await getChatChainConfig();
        console.log('Neue Nachricht:', c2.limitMessage);
        readline.prompt();
        continue;
      }

      console.log('Unbekannter Befehl. Tippe "verlassen" zum Beenden.');
      readline.prompt();
    }
  } catch (err) {
    console.error('Fehler:', err);
    process.exit(1);
  }
}