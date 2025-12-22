
export enum Pacing {
  COMPACT = '紧凑',
  MODERATE = '适中',
  LEISURE = '休闲'
}

export enum AccommodationType {
  CAR = '车住',
  HOTEL = '酒店'
}

export interface LocationPoint {
  id: string;
  name: string;
  type: 'attraction' | 'restaurant' | 'parking' | 'hotel' | 'start' | 'end';
  time: string; // HH:mm
  duration: string; // e.g. "2小时"
  ticket_price?: string; // e.g. "¥120" or "免费"
  average_cost?: string; // e.g. "¥80/人"
  description: string;
  rating: number;
  user_ratings_total: number;
  arrivalTime: string;
  travelTimeToNext?: string; // e.g. "45分钟"
  lat: number;
  lng: number;
  photo_url?: string;
  address?: string;
  alternatives?: any[];
  reviews?: string[]; // Array of review texts
  photos?: string[]; // Array of photo URLs
}

export interface DayItinerary {
  day: number;
  date: string;
  transportation_cost?: string; // e.g. "¥150" (Fuel + Tolls)
  points: LocationPoint[];
}

export interface TravelPlan {
  id: string;
  title: string;
  startPoint: string;
  endPoint: string;
  startTime: string;
  endTime: string;
  durationDays: number;
  travelers: number; // Number of people
  isRoundTrip: boolean;
  pacing: Pacing;
  includeAccom: boolean;
  accommodationType: AccommodationType;
  hotelBudget: number;
  mustVisit?: string[];
  avoid?: string[];
  days: DayItinerary[];
}

export interface AppSettings {
  apiKey: string;
  baseUrl: string;
}
