import { useSearchParams } from 'react-router-dom';
import { TripJourney } from './TripJourney.tsx';
import { TripsWorkspace } from './TripsWorkspace.tsx';

export function TripsScreen() {
  const [params] = useSearchParams();
  return params.get('view') === 'details' ? <TripsWorkspace /> : <TripJourney />;
}
