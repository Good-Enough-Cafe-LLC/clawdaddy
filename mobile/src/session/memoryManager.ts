// src/session/memoryManager.ts
import { LTMStore } from './persistence';

interface LTMPattern {
  pattern: RegExp;
  key: string;
  template: string; // $1, $2 replaced with regex capture groups
}

const LTM_PATTERNS: LTMPattern[] = [
  { pattern: /my name is (\w+)/i, key: 'name', template: "User's name is $1" },
  { pattern: /(?:i'?m|i am) (\d+) years? old/i, key: 'age', template: 'User is $1 years old' },
  { pattern: /i live in ([^,.]+)/i, key: 'location', template: 'User lives in $1' },
  { pattern: /i(?:'?m| am) from ([^,.]+)/i, key: 'origin', template: 'User is from $1' },
  { pattern: /i work (?:at|for) ([^,.]+)/i, key: 'work', template: 'User works at $1' },
  { pattern: /i(?:'?m| am) a(?:n)? ([^,.]+)/i, key: 'identity', template: 'User is a $1' },
  { pattern: /(?:i'?m|i am) (?:allergic|sensitive) to ([^,.]+)/i, key: 'allergy', template: 'User is allergic to $1' },
  { pattern: /(?:i prefer|i like|i love) ([^,.]+)/i, key: 'preference', template: 'User prefers $1' },
  { pattern: /(?:i don'?t like|i hate|i dislike) ([^,.]+)/i, key: 'dislike', template: 'User dislikes $1' },
  { pattern: /call me (\w+)/i, key: 'name', template: 'User prefers to be called $1' },
  { pattern: /my favorite (\w+) is ([^,.]+)/i, key: 'favorite_$1', template: "User's favorite $1 is $2" },
];

export const extractLTMFacts = (
  text: string,
  existing: LTMStore,
): { updated: LTMStore; newKeys: string[] } => {
  const updated = { ...existing };
  const newKeys: string[] = [];

  for (const { pattern, key, template } of LTM_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    
    const fact = template.replace(/\$(\d+)/g, (_, n) => (match[parseInt(n)] ?? '').trim()).trim();
    
    if (fact && updated[key] !== fact) {
      updated[key] = fact;
      newKeys.push(key);
    }
  }

  return { updated, newKeys };
};

export const formatLTM = (ltm: LTMStore): string => {
  const facts = Object.values(ltm);
  return facts.length === 0 ? '' : facts.join('\n');
};

// Rough token estimation - 1 token ≈ 4 chars for English
export const estimateTokens = (text: string): number => {
  return Math.ceil(text.length / 4);
};