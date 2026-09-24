import assert from 'node:assert/strict'
import { courseIdFromDocumentId, deriveCourses, parseCourseCatalog, parseRootReadme } from '../packages/reader/src/content/derive.ts'

const catalog = parseCourseCatalog({
  schema_version: 2,
  categories: [
    { id: 'computer', name: '计算机' },
    { id: 'computer.programming', name: '编程语言' },
    { id: 'computer.ai', name: '人工智能' },
  ],
  courses: {
    '课程A': {
      title: '课程 A',
      direction: '编程语言 · 测试',
      publish_path: '计算机/编程语言/课程A',
      category_paths: ['computer.programming', 'computer.ai'],
      tags: ['测试'],
    },
  },
})

const nestedFiles = [
  { path: '计算机/编程语言/课程A/textbooks/模块01_测试_精读全书.md', type: 'blob', size: 10 },
  { path: '计算机/编程语言/课程A/notes/笔记01_测试_笔记.md', type: 'blob', size: 10 },
  { path: '计算机/编程语言/课程A/subtitles/BLK01_P01_逐字稿.md', type: 'blob', size: 10 },
  { path: '计算机/编程语言/课程A/subtitles/P01_测试_clean.txt', type: 'blob', size: 10 },
  { path: '计算机/编程语言/课程A/README.md', type: 'blob', size: 10 },
  { path: '计算机/README.md', type: 'blob', size: 10 },
]
const readme = parseRootReadme('| [**课程 A**](计算机/编程语言/课程A/) | 编程语言 · 测试 | 1 | 1 | 1 | 2 |', catalog)
const courses = deriveCourses(nestedFiles, readme, catalog)
assert.equal(courses.length, 1)
assert.equal(courses[0].id, '课程A')
assert.equal(courses[0].publishPath, '计算机/编程语言/课程A')
assert.deepEqual(courses[0].categoryPaths, ['computer.programming', 'computer.ai'])
assert.equal(courses[0].volumes.length, 1)
assert.equal(courses[0].notes.length, 1)
assert.equal(courses[0].subtitles.length, 2)
assert.deepEqual(
  new Set(courses[0].subtitles.map((doc) => doc.id)),
  new Set([
    '计算机/编程语言/课程A/subtitles/BLK01_P01_逐字稿.md',
    '计算机/编程语言/课程A/subtitles/P01_测试_clean.txt',
  ]),
)
assert.equal(courseIdFromDocumentId(courses[0].volumes[0].id), '课程A')

const oldCourses = deriveCourses([
  { path: '旧课程/textbooks/模块01_旧_精读全书.md', type: 'blob', size: 10 },
  { path: '旧课程/notes/笔记01_旧_笔记.md', type: 'blob', size: 10 },
])
assert.equal(oldCourses.length, 1)
assert.equal(oldCourses[0].id, '旧课程')
assert.equal(oldCourses[0].volumes.length, 1)

const noArtifacts = deriveCourses([{ path: '计算机/README.md', type: 'blob', size: 10 }], undefined, catalog)
assert.equal(noArtifacts.length, 0)

console.log('derive check passed')
