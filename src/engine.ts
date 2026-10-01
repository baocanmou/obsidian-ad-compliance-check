export type Level = 'ban' | 'caution' | 'evidence';

export const LEVEL_LABEL: Record<Level, string> = {
	ban: '禁用',
	caution: '慎用',
	evidence: '需依据',
};

const LEVEL_RANK: Record<Level, number> = { ban: 0, caution: 1, evidence: 2 };

export interface RuleDef {
	level: Level;
	/** Literal words or phrases. */
	terms?: string[];
	/** Regular expression source, for expressions that vary (numbers, units). */
	pattern?: string;
	/** Phrases containing a term that are not a risk, e.g. 第一步 for 第一. */
	except?: string[];
	/** Regular expression source for contexts that are not a risk; a match must cover the term. */
	exceptPattern?: string;
	reason: string;
	basis: string;
	suggest?: string[];
}

export interface Pack {
	id: string;
	name: string;
	desc: string;
	defaultOn: boolean;
	rules: RuleDef[];
}

export interface CompiledRule {
	re: RegExp;
	exceptRe: RegExp | null;
	def: RuleDef;
	pack: string;
}

export interface Ruleset {
	rules: CompiledRule[];
	whitelistRe: RegExp | null;
}

export interface Hit {
	from: number;
	to: number;
	text: string;
	line: number;
	level: Level;
	reason: string;
	basis: string;
	suggest: string[];
	pack: string;
}

export interface NoteOptions {
	enabled: boolean;
	packs: string[];
}

type Range = [number, number];

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function literalRegExp(words: string[], pattern?: string): RegExp | null {
	const parts = [...new Set(words.map((w) => w.trim()).filter(Boolean))]
		.sort((a, b) => b.length - a.length)
		.map(escapeRegExp);
	if (pattern) parts.push(`(?:${pattern})`);
	return parts.length ? new RegExp(parts.join('|'), 'gim') : null;
}

export function compileRule(def: RuleDef, pack: string): CompiledRule | null {
	const parts = [...new Set(def.terms ?? [])]
		.filter(Boolean)
		.sort((a, b) => b.length - a.length)
		.map(escapeRegExp);
	if (def.pattern) parts.push(`(?:${def.pattern})`);
	if (!parts.length) return null;
	try {
		return {
			re: new RegExp(parts.join('|'), 'gim'),
			exceptRe: literalRegExp(def.except ?? [], def.exceptPattern),
			def,
			pack,
		};
	} catch {
		// An invalid user-supplied pattern is skipped rather than breaking the whole check.
		return null;
	}
}

export function compileRuleset(rules: Array<{ def: RuleDef; pack: string }>, whitelist: string[]): Ruleset {
	const compiled: CompiledRule[] = [];
	for (const r of rules) {
		const c = compileRule(r.def, r.pack);
		if (c) compiled.push(c);
	}
	return { rules: compiled, whitelistRe: literalRegExp(whitelist) };
}

function findAll(re: RegExp, text: string): Range[] {
	const out: Range[] = [];
	re.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		if (m[0].length === 0) {
			re.lastIndex++;
			continue;
		}
		out.push([m.index, m.index + m[0].length]);
	}
	return out;
}

function mergeRanges(ranges: Range[]): Range[] {
	ranges.sort((a, b) => a[0] - b[0]);
	const out: Range[] = [];
	for (const r of ranges) {
		const last = out[out.length - 1];
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
		else out.push([r[0], r[1]]);
	}
	return out;
}

/** First range that ends after `pos`, in a sorted, merged list. */
function rangeAfter(ranges: Range[], pos: number): Range | undefined {
	let lo = 0;
	let hi = ranges.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if ((ranges[mid] as Range)[1] <= pos) lo = mid + 1;
		else hi = mid;
	}
	return ranges[lo];
}

function overlaps(ranges: Range[], from: number, to: number): boolean {
	const r = rangeAfter(ranges, from);
	return !!r && r[0] < to;
}

function within(ranges: Range[], from: number, to: number): boolean {
	const r = rangeAfter(ranges, from);
	return !!r && r[0] <= from && r[1] >= to;
}

const FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Parts of a note that are not published copy: frontmatter, code, links, comments. */
export function maskRanges(text: string): Range[] {
	const ranges: Range[] = [];
	const fm = FRONTMATTER.exec(text);
	if (fm) ranges.push([0, fm[0].length]);

	let pos = 0;
	let fence: string | null = null;
	let fenceStart = 0;
	for (const line of text.split('\n')) {
		const marker = /^\s*(```+|~~~+)/.exec(line)?.[1];
		if (marker) {
			if (fence === null) {
				fence = marker.slice(0, 3);
				fenceStart = pos;
			} else if (marker.startsWith(fence)) {
				ranges.push([fenceStart, pos + line.length]);
				fence = null;
			}
		}
		pos += line.length + 1;
	}
	if (fence !== null) ranges.push([fenceStart, text.length]);

	for (const re of [
		/`[^`\n]+`/g,
		/https?:\/\/[^\s)\]>]+/g,
		/\[\[[^\]\n]*\]\]/g,
		/\]\([^)\n]*\)/g,
		/%%[\s\S]*?%%/g,
		/<!--[\s\S]*?-->/g,
	]) {
		ranges.push(...findAll(re, text));
	}
	return mergeRanges(ranges);
}

export function scan(text: string, ruleset: Ruleset): Hit[] {
	if (!ruleset.rules.length) return [];
	const masks = maskRanges(text);
	const allowed = ruleset.whitelistRe ? mergeRanges(findAll(ruleset.whitelistRe, text)) : [];
	const found: Array<{ range: Range; rule: CompiledRule }> = [];

	for (const rule of ruleset.rules) {
		const matches = findAll(rule.re, text);
		if (!matches.length) continue;
		const excepted = rule.exceptRe ? mergeRanges(findAll(rule.exceptRe, text)) : [];
		for (const range of matches) {
			if (overlaps(masks, range[0], range[1])) continue;
			if (within(excepted, range[0], range[1])) continue;
			if (within(allowed, range[0], range[1])) continue;
			found.push({ range, rule });
		}
	}

	// Where expressions overlap, keep the earliest, then the longest, then the most severe.
	found.sort(
		(a, b) =>
			a.range[0] - b.range[0] ||
			b.range[1] - a.range[1] ||
			LEVEL_RANK[a.rule.def.level] - LEVEL_RANK[b.rule.def.level],
	);

	const hits: Hit[] = [];
	let lastEnd = 0;
	let line = 1;
	let counted = 0;
	for (const { range, rule } of found) {
		if (range[0] < lastEnd) continue;
		lastEnd = range[1];
		for (let i = counted; i < range[0]; i++) if (text.charCodeAt(i) === 10) line++;
		counted = range[0];
		hits.push({
			from: range[0],
			to: range[1],
			text: text.slice(range[0], range[1]),
			line,
			level: rule.def.level,
			reason: rule.def.reason,
			basis: rule.def.basis,
			suggest: rule.def.suggest ?? [],
			pack: rule.pack,
		});
	}
	return hits;
}

function splitList(value: string): string[] {
	return value
		.split(/[,，、]/)
		.map((s) => s.trim().replace(/^["']|["']$/g, ''))
		.filter(Boolean);
}

/** Reads the per-note switch and extra word lists from frontmatter text. */
export function parseNoteOptions(text: string, switchKey: string, packsKey: string): NoteOptions {
	const options: NoteOptions = { enabled: true, packs: [] };
	const fm = FRONTMATTER.exec(text);
	if (!fm) return options;
	const lines = fm[0].split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const m = /^([^:#\s][^:]*):\s*(.*)$/.exec(lines[i] ?? '');
		if (!m) continue;
		const key = (m[1] ?? '').trim();
		const value = (m[2] ?? '').trim();
		if (key === switchKey) {
			options.enabled = !/^(false|no|off|否|关|关闭)$/i.test(value.replace(/^["']|["']$/g, ''));
		} else if (key === packsKey) {
			if (value.startsWith('[')) {
				options.packs = splitList(value.replace(/^\[|\]$/g, ''));
			} else if (value) {
				options.packs = splitList(value);
			} else {
				for (let j = i + 1; j < lines.length; j++) {
					const item = /^\s*-\s+(.+)$/.exec(lines[j] ?? '');
					if (!item) break;
					options.packs.push(...splitList(item[1] ?? ''));
				}
			}
		}
	}
	return options;
}

const LEVEL_WORDS: Record<string, Level> = {
	禁用: 'ban',
	禁: 'ban',
	慎用: 'caution',
	慎: 'caution',
	需依据: 'evidence',
	依据: 'evidence',
};

/**
 * One rule per line: `词语 | 级别 | 建议1、建议2 | 说明`.
 * Only the word is required. A word written as `/.../` is a regular expression.
 */
export function parseCustomWords(text: string, basis: string): RuleDef[] {
	const rules: RuleDef[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const cols = line.split(/[|｜]/).map((s) => s.trim());
		const word = cols[0] ?? '';
		if (!word) continue;
		const rule: RuleDef = {
			level: LEVEL_WORDS[cols[1] ?? ''] ?? 'caution',
			reason: cols[3] || '自定义词库中的词语。',
			basis,
			suggest: cols[2] ? splitList(cols[2]) : [],
		};
		const re = /^\/(.+)\/$/.exec(word);
		if (re) rule.pattern = re[1];
		else rule.terms = [word];
		rules.push(rule);
	}
	return rules;
}

export function parseLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter((s) => s && !s.startsWith('#'));
}

export function countByLevel(hits: Hit[]): Record<Level, number> {
	const n: Record<Level, number> = { ban: 0, caution: 0, evidence: 0 };
	for (const h of hits) n[h.level]++;
	return n;
}
