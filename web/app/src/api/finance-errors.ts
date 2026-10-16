/** A transport failure is not evidence that the server rejected a financial write. */
export class FinanceSaveUncertainError extends Error {
  constructor() {
    super(
      'З’єднання із сервером перервалося. Не вдалося підтвердити збереження. Натисни «Перевірити збереження»: повторимо той самий запит без дублювання.',
    );
    this.name = 'FinanceSaveUncertainError';
  }
}
export class FinanceCommandRejectedError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'FinanceCommandRejectedError';
  }
}
