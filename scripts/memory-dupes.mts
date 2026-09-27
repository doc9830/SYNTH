/**
 * Отчёт по дублям в памяти — только чтение, ничего не удаляет.
 *
 * Зачем: посмотреть, сколько записей схлопнулось бы при склейке по основам
 * слов (задача 05.1). Файл берётся из приложения: «⋮» → «Память» →
 * «Экспорт .json» (в APK файл ложится в «Загрузки/SYNTH»).
 *
 * Запуск:
 *   npm run memory:dupes -- ~/Загрузки/memory-synth-2026-09-27.json
 */
import { readFileSync } from 'node:fs'
import { memoryDuplicateReport, parseMemoryDump } from '@/lib/memory'

const path = process.argv[2]
if (!path) {
  console.error('Укажите путь к JSON-дампу памяти: npm run memory:dupes -- memory.json')
  process.exit(1)
}

const raw = readFileSync(path, 'utf8')
const entries = parseMemoryDump(raw)
let fileRecords = 0
try {
  const parsed: unknown = JSON.parse(raw)
  fileRecords = Array.isArray(parsed) ? parsed.length : 0
} catch {
  console.error('Файл не похож на JSON-дамп памяти.')
  process.exit(1)
}

const report = memoryDuplicateReport(entries)
console.log(`Файл: ${path}`)
console.log(`Записей в файле: ${fileRecords}, принято к сравнению: ${report.entries}`)
console.log(`Схлопнулось бы при склейке: ${report.merged}`)
console.log(`Осталось бы записей: ${report.kept}`)
if (report.pairs.length) {
  console.log('\nПары (подробная формулировка ← влившаяся):')
  for (const pair of report.pairs) {
    console.log(
      `- «${pair.merged}» → «${pair.master}» (Jaccard ${pair.score.toFixed(2)}, вложенность ${pair.containment.toFixed(2)})`,
    )
  }
}
