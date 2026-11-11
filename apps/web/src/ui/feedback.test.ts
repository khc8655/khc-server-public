import { describe, expect, it } from 'vitest';
import { iconNames, iconPaths } from './icons';
import { bannerIcon } from './feedback';

describe('bannerIcon（Banner tone → 图标映射）', () => {
  it('五种 tone 映射到语义正确的图标', () => {
    expect(bannerIcon).toEqual({
      ok: 'check',
      warn: 'alert',
      danger: 'alert',
      info: 'info',
      neutral: 'info',
    });
  });

  it('映射到的图标都登记在封闭图标集内', () => {
    for (const name of Object.values(bannerIcon)) {
      expect(iconNames).toContain(name);
      expect(iconPaths[name].length).toBeGreaterThan(0);
    }
  });
});

describe('封闭图标集完整性', () => {
  it('每个登记的图标名都有 path，且无多余 path', () => {
    expect(Object.keys(iconPaths).sort()).toEqual([...iconNames].sort());
  });
});
