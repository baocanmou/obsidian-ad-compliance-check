import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCustomWords, parseNoteOptions } from '../src/engine';
import { Analyzer, DEFAULT_SETTINGS, type ComplianceSettings } from '../src/ruleset';

function check(text: string, overrides: Partial<ComplianceSettings> = {}, path: string | null = 'a.md') {
	const settings = { ...DEFAULT_SETTINGS, ...overrides };
	return new Analyzer(() => settings).analyze(path, text);
}
const words = (text: string, overrides: Partial<ComplianceSettings> = {}, path: string | null = 'a.md') =>
	check(text, overrides, path).hits.map((h) => h.text);

test('flags absolute terms with level and position', () => {
	const { hits } = check('第一行\n我们是南昌最好的品牌设计公司。');
	assert.deepEqual(hits.map((h) => [h.text, h.level, h.line]), [['最好', 'ban', 2]]);
	assert.equal('第一行\n我们是南昌最好的品牌设计公司。'.slice(hits[0]!.from, hits[0]!.to), '最好');
});

test('ordinal uses of 第一 are not flagged, ranking uses are', () => {
	assert.deepEqual(words('第一步先看定位，这是顾客的第一眼。第一，名字要好记。\n**第一、**先定位。第一问：你是谁？'), []);
	assert.deepEqual(words('做体检最好先看定位，这是最好的办法，也是你最大的对手没做的事。'), []);
	assert.deepEqual(words('南昌最好的米粉，味道最好。全城最大的门店。'), ['最好', '最好', '最大']);
	assert.deepEqual(words('我们做到了本地销量第一，是顾客心中的第一。'), ['销量第一', '第一']);
});

test('longest expression wins when terms overlap', () => {
	assert.deepEqual(words('承诺100%有效。'), ['100%有效']);
	assert.deepEqual(words('全国首家社区烘焙店'), ['全国首家']);
});

test('income and payback patterns', () => {
	assert.deepEqual(words('加盟后3个月回本，轻松月入5万，稳赚不赔。'), ['3个月回本', '轻松月入', '稳赚不赔']);
	assert.deepEqual(words('半年内回本'), ['半年内回本']);
});

test('frontmatter, code, links and comments are skipped', () => {
	const text = [
		'---',
		'title: 最好的方案',
		'---',
		'正文很普通。`最佳` [[最好的笔记]] [链接](https://a.com/顶级)',
		'```',
		'顶级',
		'```',
		'%% 最强 %% <!-- 第一品牌 -->',
		'这句有顶尖。',
	].join('\n');
	assert.deepEqual(words(text), ['顶尖']);
});

test('industry packs are off by default and can be added per note', () => {
	const body = '这款饮品可以降血糖。';
	assert.deepEqual(words(body), []);
	assert.deepEqual(words(`---\n合规词库: [疾病与医疗用语]\n---\n${body}`), ['降血糖']);
	assert.deepEqual(words(`---\n合规词库:\n  - medical\n---\n${body}`), ['降血糖']);
	assert.deepEqual(words(body, { enabledPacks: ['medical'] }), ['降血糖']);
});

test('per-note switch turns the check off', () => {
	const result = check('---\n合规检查: false\n---\n最好的');
	assert.equal(result.active, false);
	assert.deepEqual(result.hits, []);
});

test('folder rules add packs and words only inside the folder', () => {
	const folderRules = [{ folder: '客户/健康客户', packs: ['medical'], words: '古法 | 禁用 | 传统工艺 | 客户要求' }];
	assert.deepEqual(words('古法熬制，能降血糖。', { folderRules }, '客户/健康客户/文案.md'), ['古法', '降血糖']);
	assert.deepEqual(words('古法熬制，能降血糖。', { folderRules }, '客户/健康客户2/文案.md'), []);
	const hit = check('古法熬制', { folderRules }, '客户/健康客户/文案.md').hits[0]!;
	assert.deepEqual([hit.level, hit.suggest, hit.reason], ['ban', ['传统工艺'], '客户要求']);
});

test('include and exclude folders set the scope', () => {
	assert.equal(check('最好', { includeFolders: '内容创作' }, '笔记/a.md').active, false);
	assert.deepEqual(words('最好', { includeFolders: '内容创作' }, '内容创作/a.md'), ['最好']);
	assert.equal(check('最好', { excludeFolders: '方法论\n模板' }, '模板/a.md').active, false);
});

test('whitelist phrases suppress the words inside them', () => {
	assert.deepEqual(words('南昌第一食品厂的顶级产品', { whitelist: '第一食品厂' }), ['顶级']);
	assert.deepEqual(words('顶级', { whitelist: '顶级' }), []);
});

test('custom words: levels, regular expressions, comments', () => {
	const rules = parseCustomWords('# 注释\n门头 | 禁用 | 品牌表达\n/保\\d+年/ | 需依据\n只有词', '自定义词库');
	assert.equal(rules.length, 3);
	assert.deepEqual(words('门头要醒目，保10年。', { customWords: '门头 | 禁用 | 品牌表达\n/保\\d+年/ | 需依据' }), ['门头', '保10年']);
	assert.deepEqual(words('正常', { customWords: '/([/ | 禁用' }), []);
});

test('note options parser handles inline and list forms', () => {
	assert.deepEqual(parseNoteOptions('---\n合规词库: 教育培训、房地产\n---\n', '合规检查', '合规词库').packs, ['教育培训', '房地产']);
	assert.deepEqual(parseNoteOptions('没有属性', '合规检查', '合规词库'), { enabled: true, packs: [] });
});

test('no false positive on common safe phrases', () => {
	assert.deepEqual(words('最近我们在做一个有机会落地的项目，最后效果不错，保健食品另说。', { enabledPacks: ['absolute', 'food'] }), []);
});
