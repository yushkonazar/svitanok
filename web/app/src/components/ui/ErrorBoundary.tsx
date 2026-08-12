import { Component, type ErrorInfo, type ReactNode } from 'react';

// Межа помилок (аудит C2: «немає ErrorBoundary — один throw гасить застосунок»).
//
// ЧОМУ ЦЕ ВАЖЛИВО САМЕ ТУТ. React 19 при неспійманій помилці рендера
// РОЗМОНТОВУЄ все дерево — тобто власник бачить не «зламався графік», а порожній
// білий екран у чаті. Дані при цьому цілі: майже кожна така помилка — це
// несподівана форма одного блоку (`undefined` там, де чекали масив), а не
// поламаний застосунок.
//
// Тому межа СВІДОМО не глобальна: обгортаємо вміст екрана, а не весь застосунок,
// щоб шапка, таб-бар і навігація лишались живими — з розбитого екрана має бути
// куди піти.
//
// ⚠️ Class-компонент тут не архаїзм: getDerivedStateFromError/componentDidCatch
// не мають хукового еквівалента (React 19).

interface Props {
  children: ReactNode;
  /** Що саме впало — у текст для власника («Статистика» -> «Не вдалось показати Статистику»). */
  label?: string;
  /** Скидання межі ззовні: зміна значення (напр. шляху) відроджує дерево. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidUpdate(prev: Props) {
    // Перехід на інший екран мусить давати чистий старт: інакше одна помилка
    // залипає на весь сеанс і виглядає як «апка зламалась назавжди».
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Консоль вебвʼю Telegram доступна через дебаг — це єдиний слід, який
    // лишається від помилки на пристрої власника.
    console.error('UI error', this.props.label ?? '', error, info.componentStack);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    const what = this.props.label ? `«${this.props.label}»` : 'цей екран';
    return (
      <div
        role="alert"
        className="mx-4 my-6 flex flex-col gap-2 rounded-2xl border border-glassb bg-glass p-4"
      >
        <span className="text-[13px] font-semibold">Не вдалось показати {what}</span>
        <span className="text-[11px] text-tx2">
          Дані на місці — зламалось саме відображення. Спробуй перейти на іншу вкладку й назад або
          перезапустити застосунок.
        </span>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="mt-1 self-start rounded-xl border border-glassb bg-glass px-3 py-1.5 text-[11px]"
        >
          Спробувати ще раз
        </button>
      </div>
    );
  }
}
