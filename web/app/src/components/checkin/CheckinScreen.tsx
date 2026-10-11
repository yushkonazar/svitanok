import { useSearchParams } from 'react-router-dom';
import { CheckinV3Screen } from './CheckinV3Screen.tsx';
export function CheckinScreen() {
  const [params] = useSearchParams();
  return (
    <CheckinV3Screen
      key={`${params.get('date')}:${params.get('slot')}`}
      target={{ date: params.get('date'), slot: params.get('slot') }}
    />
  );
}
