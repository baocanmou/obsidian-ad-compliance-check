import { LEVEL_LABEL, countByLevel, type Hit } from './engine';
import type { Analysis } from './ruleset';

export const DISCLAIMER = '本检查按词库提示风险表达，供发布前自查，不构成法律意见；是否违法以具体语境和监管认定为准。';

export function summary(hits: Hit[]): string {
	const n = countByLevel(hits);
	if (!hits.length) return '未发现风险表达';
	return (['ban', 'caution', 'evidence'] as const)
		.filter((l) => n[l])
		.map((l) => `${LEVEL_LABEL[l]} ${n[l]}`)
		.join(' · ');
}

function cell(s: string): string {
	return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function buildReport(title: string, analysis: Analysis, date: string): string {
	const lines = [
		`# 合规检查报告：${title}`,
		'',
		`- 检查时间：${date}`,
		`- 使用词库：${analysis.packNames.join('、') || '无'}`,
		`- 结果：${summary(analysis.hits)}`,
		'',
	];
	if (analysis.hits.length) {
		lines.push('| 行 | 表达 | 级别 | 问题 | 依据 | 建议 |', '| --- | --- | --- | --- | --- | --- |');
		for (const h of analysis.hits) {
			lines.push(
				`| ${h.line} | ${cell(h.text)} | ${LEVEL_LABEL[h.level]} | ${cell(h.reason)} | ${cell(h.basis)} | ${cell(h.suggest.join('；'))} |`,
			);
		}
		lines.push('');
	}
	lines.push(`> ${DISCLAIMER}`, '');
	return lines.join('\n');
}
