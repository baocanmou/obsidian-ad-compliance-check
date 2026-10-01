import { RangeSetBuilder, type Extension } from '@codemirror/state';
import {
	Decoration,
	EditorView,
	ViewPlugin,
	hoverTooltip,
	type DecorationSet,
	type ViewUpdate,
} from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import { LEVEL_LABEL, type Hit } from './engine';
import type { Analysis } from './ruleset';

export interface EditorHost {
	analyze(path: string | null, text: string): Analysis;
	addToWhitelist(term: string): Promise<void>;
}

const MARKS = {
	ban: Decoration.mark({ class: 'compliance-hit compliance-ban' }),
	caution: Decoration.mark({ class: 'compliance-hit compliance-caution' }),
	evidence: Decoration.mark({ class: 'compliance-hit compliance-evidence' }),
};

/** Underlines risky expressions in the editor and explains them on hover. */
export function complianceExtension(host: EditorHost): Extension {
	const marker = ViewPlugin.fromClass(
		class {
			hits: Hit[] = [];
			decorations: DecorationSet = Decoration.none;

			constructor(view: EditorView) {
				this.compute(view);
			}

			update(update: ViewUpdate) {
				if (update.docChanged) this.compute(update.view);
			}

			compute(view: EditorView) {
				const path = view.state.field(editorInfoField, false)?.file?.path ?? null;
				this.hits = host.analyze(path, view.state.doc.toString()).hits;
				const builder = new RangeSetBuilder<Decoration>();
				for (const h of this.hits) builder.add(h.from, h.to, MARKS[h.level]);
				this.decorations = builder.finish();
			}
		},
		{ decorations: (v) => v.decorations },
	);

	const tooltip = hoverTooltip((view, pos) => {
		const hit = view.plugin(marker)?.hits.find((h) => h.from <= pos && h.to >= pos);
		if (!hit) return null;
		return {
			pos: hit.from,
			end: hit.to,
			above: true,
			create: () => ({ dom: tooltipDom(view, hit, host) }),
		};
	});

	return [marker, tooltip];
}

function tooltipDom(view: EditorView, hit: Hit, host: EditorHost): HTMLElement {
	const dom = createDiv({ cls: 'compliance-tooltip' });
	const head = dom.createDiv({ cls: 'compliance-tooltip-head' });
	head.createSpan({ cls: `compliance-badge compliance-badge-${hit.level}`, text: LEVEL_LABEL[hit.level] });
	head.createSpan({ cls: 'compliance-tooltip-term', text: hit.text });
	dom.createDiv({ cls: 'compliance-tooltip-reason', text: hit.reason });
	dom.createDiv({ cls: 'compliance-tooltip-basis', text: `依据：${hit.basis}` });

	const actions = dom.createDiv({ cls: 'compliance-tooltip-actions' });
	for (const s of hit.suggest) {
		// A suggestion is either a short replacement or a longer piece of advice.
		if (isReplacement(s)) {
			const btn = actions.createEl('button', { text: `换成“${s}”` });
			btn.addEventListener('click', () => {
				view.dispatch({ changes: { from: hit.from, to: hit.to, insert: s } });
			});
		} else {
			dom.createDiv({ cls: 'compliance-tooltip-advice', text: `建议：${s}` });
		}
	}
	const allow = actions.createEl('button', { text: '加入白名单' });
	allow.addEventListener('click', () => {
		void host.addToWhitelist(hit.text);
	});
	return dom;
}

/** Built-in suggestions are advice sentences; custom words usually give a direct replacement. */
export function isReplacement(suggestion: string): boolean {
	return suggestion.length <= 8 && !/[，。：；]/.test(suggestion);
}
