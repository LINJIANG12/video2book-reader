import assert from 'node:assert/strict'
import { buildCategoryTree, categoryContainsCourse, countCategory, groupCourses } from '../packages/reader/src/content/category-tree.ts'

const categories = [
  { id: 'computer', name: '计算机' },
  { id: 'computer.programming', name: '编程语言' },
  { id: 'computer.ai', name: '人工智能' },
  { id: 'computer.ai.nlp', name: '自然语言处理' },
  { id: 'math', name: '数学' },
  { id: 'math.calculus', name: '微积分' },
  { id: 'unmapped', name: '未映射分类' },
]
const courses = [
  { id: 'python', title: 'Python', direction: '', volumeCount: 2, noteCount: 1, subtitleCount: 3, categoryPaths: ['computer.programming', 'computer.ai'] },
  { id: 'nlp', title: 'NLP', direction: '', volumeCount: 1, noteCount: 1, subtitleCount: 2, categoryPaths: ['computer.ai.nlp'] },
  { id: 'math', title: '数学', direction: '', volumeCount: 3, noteCount: 2, subtitleCount: 0, categoryPaths: ['math.calculus'] },
  { id: 'legacy', title: '旧课程', direction: '', volumeCount: 1, noteCount: 0, subtitleCount: 0 },
]

const tree = buildCategoryTree(categories)
assert.deepEqual(tree.map((node) => node.id), ['computer', 'math', 'unmapped'])
assert.deepEqual(tree[0].children.map((node) => node.id), ['computer.programming', 'computer.ai'])
assert.deepEqual(tree[0].children[1].children.map((node) => node.id), ['computer.ai.nlp'])
assert.equal(countCategory(courses, 'computer'), 2)
assert.equal(countCategory(courses, 'computer.ai'), 2)
assert.equal(categoryContainsCourse(courses[0], 'computer'), true)
assert.equal(categoryContainsCourse(courses[0], 'computer.ai.nlp'), false)

const allGroups = groupCourses(courses, null, categories)
assert.deepEqual(allGroups.map((group) => group.id), ['computer.programming', 'computer.ai.nlp', 'math.calculus', '__uncategorized__'])
assert.equal(allGroups.flatMap((group) => group.courses).length, courses.length)
assert.equal(new Set(allGroups.flatMap((group) => group.courses.map((course) => course.id))).size, courses.length)

const aiGroups = groupCourses(courses, 'computer.ai', categories)
assert.deepEqual(aiGroups.map((group) => group.id), ['computer.ai', 'computer.ai.nlp'])
assert.equal(aiGroups.flatMap((group) => group.courses).length, 2)

console.log('bookshelf check passed')
