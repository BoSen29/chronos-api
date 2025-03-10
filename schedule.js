const hash = require('object-hash')
const schedule = require('node-schedule')
const { exec, spawn } = require('child-process-async')
const { exec_success, exec_error } = require('./metrics')
const utils = require('./utils')
const crud = require('./crud')

let schedules = {}

const getTaskHash = (task) => {
  let _task = Object.assign({}, task)
  delete _task.created
  delete _task.updated
  _task.steps.forEach(s => {
    delete s.created
    delete s.updated
  })
  return hash(_task)
}

const run = async function(task) {
  // TODO: Wrap in try/cath ??
  let client = utils.getClient()
  await client.connect()
  let etask = await crud.get(client, 'tasks', { id: this.task.id }).then(raw => raw.rows)
  etask = etask[0]
  if (etask.paused) throw new Error(`Task ${etask.id} tried to run even if task if paused`)
  await doRun(etask.id, client)
  await client.end()
}

const doRun = async function(taskid, client) {
  let steps = await crud.get(client, 'steps', { task: taskid }, { order: { 'sort_order': 'asc' } }).then(raw => raw.rows)
  for (let step of steps) {
    await doStep(client, step)
  }
}

const doStep = async function(client, step) {
  console.log(`Running step ${step.name} with id ${step.id}`)
  var _stdout, _stderr, exitcode;
  var time_start = new Date()
  try {
    let { stdout, stderr } = await exec(step.command)
    _stdout = stdout
    _stderr = stderr
    exitcode = 0
  } catch(e) {
    _stdout = ''
    _stderr = e.message
    exitcode = e.code
  }
  let time_end = new Date()
  await crud.post(client, 'execs', {
    step: step.id,
    stdout: _stdout,
    stderr: _stderr,
    exitcode: exitcode,
    time_start: time_start,
    time_end: time_end
  })
  if (exitcode === 0) exec_success.inc()
  else exec_error.inc()
}

const scheduleTask = (task) => {
  let taskHash = getTaskHash(task)
  schedules[task.id] = {
    hash: taskHash,
    job: schedule.scheduleJob(task.cron, run.bind({task: {id: task.id}}))
  }
}

const init = async () => {
  let client = utils.getClient()
  await client.connect()
  let tasks = await crud.get(client, 'tasks').then(raw => raw.rows)
  tasks = tasks.filter(t => !t.paused)
  for (let task of tasks) {
    task.steps = await crud.get(client, 'steps', { task: task.id }).then(raw => raw.rows)
    scheduleTask(task)
  }
  await client.end()
}

const update = async (id) => {
  let client = utils.getClient()
  await client.connect()
  let task = await crud.get(client, 'tasks', { id: id }).then(raw => raw.rows)
  task = task[0]
  task.steps = await crud.get(client, 'steps', { task: id }).then(raw => raw.rows)
  let taskHash = getTaskHash(task)
  if (task.paused && schedules[task.id] != undefined) {
    console.log('Task paused, removing...')
    schedules[task.id].job.cancel()
    delete schedules[task.id]
  }
  if (!task.paused && schedules[task.id] == undefined) {
    console.log('Task un-paused, adding...')
    scheduleTask(task)
  }
  if (!task.paused && schedules[task.id] != undefined) {
    if (taskHash != schedules[task.id].hash) {
      console.log('Task changed, reinstalling...')
      schedules[task.id].job.cancel()
      scheduleTask(task)
    }
  }
  await client.end()
}

const remove = async (id) => {
  if (schedules[id] != undefined) {
    schedules[id].job.cancel()
    delete schedules[id]
  }
}

module.exports = {
  init,
  update,
  remove,
  doRun,
  doStep,
  getTaskHash
}
