// Реєстр задач планувальника: kind -> {periodMin, shadowSafe, run}. PR-3 етапу 1
// переносить сюди 10 крон-задач із CRON_TASKS; зараз тут лише heartbeat —
// носій заміру джитера alarm'а (03-plan, етап 1, PR-2: «замір джитера»).
//
// shadowSafe: true = задачу можна виконувати і в ASSISTANT_V2=shadow (немає
// побічних ефектів назовні). Без прапорця в shadow задача лише логується —
// це і є «тікає паралельно з CRON_TASKS, лише логує» з плану етапу.

/**
 * @typedef {{
 *   periodMin: number,
 *   shadowSafe?: boolean,
 *   run: (env: Env) => Promise<unknown>,
 * }} SchedulerTaskDef
 */

/** @type {Record<string, SchedulerTaskDef>} */
export const SCHEDULER_TASKS = {
  heartbeat: {
    periodMin: 5,
    shadowSafe: true,
    run: async () => {
      console.log('scheduler: heartbeat');
    },
  },
};
