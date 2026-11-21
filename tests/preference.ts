// [2026-11-13] 内容偏好过滤测试
import { matchesPreference } from '../gateway/src/e621.ts';

let pass = 0, total = 0;
const check = (n: string, c: boolean, e = '') => { total++; if (c) pass++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${e ? '  ' + e : ''}`); };

const mm = ['male', 'male/male', 'anthro', 'canine'];
const mf = ['male', 'female', 'male/female', 'anthro'];
const solo = ['solo', 'female', 'anthro'];
const soloMale = ['solo', 'male', 'anthro'];
const ff = ['female', 'female/female'];

// any：全都通过
check('any 全通过(male/male)', matchesPreference(mm, 'any'));
check('any 全通过(female/female)', matchesPreference(ff, 'any'));

// hetero：排除同性
check('hetero 排除 male/male', !matchesPreference(mm, 'hetero'));
check('hetero 排除 female/female', !matchesPreference(ff, 'hetero'));
check('hetero 通过 male/female', matchesPreference(mf, 'hetero'));
check('hetero 通过 solo', matchesPreference(solo, 'hetero'));

// solo
check('solo 通过单人', matchesPreference(solo, 'solo'));
check('solo 通过单人男性', matchesPreference(soloMale, 'solo'));
check('solo 排除 duo', !matchesPreference(['duo', 'male', 'female'], 'solo'));

// female
check('female 通过含 female', matchesPreference(solo, 'female'));
check('female 排除纯 male/male', !matchesPreference(mm, 'female'));
check('female 排除纯男单', !matchesPreference(['solo', 'male'], 'female'));

// 边界
check('空 tag + any 通过', matchesPreference([], 'any'));
check('空 tag + hetero 不通过', !matchesPreference([], 'hetero'));
check('大小写不敏感', !matchesPreference(['Male/Male'], 'hetero'));

console.log(`\n${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
