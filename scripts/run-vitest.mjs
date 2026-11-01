import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// На Windows пути к файлам не зависят от регистра. Node выводит URL модулей из
// строки, переданной в качестве точки входа, поэтому запуск через путь с иной
// буквой диска (например, e:\... вместо E:\...) приводит к загрузке Vitest под
// неканоническими URL. В итоге @vitest/runner загружается дважды, и test()
// регистрирует тест в экземпляре, который исполнитель не инициализировал —
// отсюда ошибка «Vitest failed to find the current suite».
//
// Приводим путь к точке входа к каноническому виду через realpathSync.native,
// чтобы все модули Vitest загружались под одним и тем же написанием URL.
const require = createRequire(import.meta.url);
const vitestBin = realpathSync.native(
  join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
);

const result = spawnSync(process.execPath, [vitestBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
