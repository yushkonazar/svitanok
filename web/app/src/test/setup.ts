import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Спільний setup компонентних тестів.
//
// cleanup після КОЖНОГО тесту — не формальність: без нього попередній рендер
// лишається в document, і `getByText` знаходить два збіги замість одного, а
// тест починає падати від ПОРЯДКУ виконання, а не від коду.
afterEach(cleanup);
