
import React, { useState, useEffect, useRef } from 'react';
import { 
  MapPin, Calendar, Clock, ChevronDown, ChevronUp, Navigation, 
  Settings as SettingsIcon, Search, Star, ArrowRight, Car, Hotel, 
  Save, Trash2, RefreshCw, Plus, Minus, Check, Map as MapIcon, 
  List as ListIcon, Layers, X, Loader2, LocateFixed, Compass, Moon, Sun, Utensils,
  Image as ImageIcon, MessageSquare, Ticket, Banknote, Watch, AlertTriangle, Heart, Eye,
  Maximize2, Users, Receipt, Camera
} from 'lucide-react';
import { Pacing, AccommodationType, TravelPlan, LocationPoint } from './types';
import { generateTravelPlan, getAlternativePoints, recommendDestinations } from './geminiService';

declare const google: any;

// Queue system for concurrency control
class RequestQueue {
  private queue: Array<() => Promise<void>> = [];
  private activeCount = 0;
  private maxConcurrent = 2; // Conservative limit to avoid timeouts/rate limits

  add(fn: () => Promise<void>) {
    this.queue.push(fn);
    this.process();
  }

  private async process() {
    if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) return;

    this.activeCount++;
    const fn = this.queue.shift();
    if (fn) {
      try {
        await fn();
      } catch (e) {
        console.error("Task failed", e);
      } finally {
        this.activeCount--;
        this.process();
      }
    }
  }
}

const requestQueue = new RequestQueue();

// Helper: Format Date to YYYY-MM-DDTHH:mm (Beijing Time)
const formatBeijingDate = (date: Date) => {
  const utc = date.getTime() + (date.getTimezoneOffset() * 60000);
  const beijingOffset = 8 * 60 * 60 * 1000;
  const beijingDate = new Date(utc + beijingOffset);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${beijingDate.getFullYear()}-${pad(beijingDate.getMonth() + 1)}-${pad(beijingDate.getDate())}T${pad(beijingDate.getHours())}:${pad(beijingDate.getMinutes())}`;
};

// Helper: Parse Cost
const parsePrice = (priceStr: string | undefined): number => {
  if (!priceStr) return 0;
  const match = priceStr.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
};

// Helper: Calculate Point Cost
const calculatePointCost = (pt: LocationPoint, travelers: number): number => {
  let cost = 0;
  // 1. Ticket Price (Assume per person)
  if (pt.ticket_price && !pt.ticket_price.includes("免费")) {
     cost += parsePrice(pt.ticket_price) * travelers;
  }
  
  // 2. Average Cost (Dining/Hotel)
  if (pt.average_cost && !pt.average_cost.includes("免费")) {
     const price = parsePrice(pt.average_cost);
     if (pt.type === 'hotel') {
        // Assume hotel price is per room, need 1 room per 2 people
        const rooms = Math.ceil(travelers / 2);
        cost += price * rooms;
     } else if (pt.type === 'restaurant') {
        // Dining is per person
        cost += price * travelers;
     } else {
        // Others (e.g. activities) default to per person
        cost += price * travelers;
     }
  }

  // 3. Parking (Per car, assume 1 car)
  if (pt.type === 'parking' && pt.ticket_price) {
     // Usually parking price in JSON is like "¥20" (flat or hourly). Treat as flat for simplicity.
     cost += parsePrice(pt.ticket_price);
  }

  return cost;
};

// Helper: Get Real Images via Bing Search (China Accessible)
// This uses the Bing Thumbnail API to fetch real search result images.
// This is much more reliable for specific Chinese locations than AI generation.
const getRealImages = (name: string, type: string): string[] => {
  // Define different keyword suffixes to get varied images
  // We use Chinese keywords to ensure better results for Chinese locations
  const keywords = [
    '高清大图',        // High Res
    '景色',           // Scenery
    type === 'restaurant' ? '美食' : '摄影', // Food for restaurants, Photography for others
    '旅游'            // Travel
  ];

  return keywords.map((kw, i) => {
    // Construct the query: Name + Keyword
    const query = encodeURIComponent(`${name} ${kw}`);
    
    // Rotate through Bing's subdomains (tse1 - tse4) to spread load
    // Using standard mm.bing.net which is generally accessible
    const host = `tse${(i % 4) + 1}.mm.bing.net`;
    
    // c=7: Smart crop to center the subject
    // w=800&h=600: Request reasonable quality
    return `https://${host}/th?q=${query}&w=800&h=600&c=7&rs=1`;
  });
};

const App: React.FC = () => {
  const [isFormExpanded, setIsFormExpanded] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [plan, setPlan] = useState<TravelPlan | null>(null);
  const [savedPlans, setSavedPlans] = useState<TravelPlan[]>([]);
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  
  // Details Modal
  const [selectedPoint, setSelectedPoint] = useState<LocationPoint | null>(null);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);

  // Lightbox State
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  // Alternatives Sheet
  const [showAlternatives, setShowAlternatives] = useState<{ point: LocationPoint; dayIdx: number; pointIdx: number } | null>(null);
  const [alternatives, setAlternatives] = useState<any[]>([]);
  const [isLoadingAlts, setIsLoadingAlts] = useState(false);
  
  // Recommendation State
  const [isLocating, setIsLocating] = useState(false);
  const [recommendedDestinations, setRecommendedDestinations] = useState<string[]>([]);
  const [isLoadingRecs, setIsLoadingRecs] = useState(false);

  // Settings State
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState({
    apiKey: "sk-28c0d0093c2c4486ac3b394da91f7386",
    baseUrl: "https://api.grsai.com/v1/chat/completions",
    model: "gemini-3-pro",
    googleMapsKey: "" // Added for Embed API support
  });

  // Plan Params
  const [start, setStart] = useState('上海');
  const [end, setEnd] = useState('杭州');
  const [days, setDays] = useState(3);
  const [travelers, setTravelers] = useState(2);
  const [startTime, setStartTime] = useState(formatBeijingDate(new Date()));
  const [endTime, setEndTime] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 3);
    return formatBeijingDate(d);
  });
  const [isRoundTrip, setIsRoundTrip] = useState(true);
  const [pacing, setPacing] = useState<Pacing>(Pacing.MODERATE);
  const [includeAccom, setIncludeAccom] = useState(true);
  const [accommodationType, setAccommodationType] = useState<AccommodationType>(AccommodationType.HOTEL);
  const [hotelBudget, setHotelBudget] = useState(500);

  // Advanced Params: Must Visit / Avoid
  const [mustVisitInput, setMustVisitInput] = useState("");
  const [mustVisitList, setMustVisitList] = useState<string[]>([]);
  const [avoidInput, setAvoidInput] = useState("");
  const [avoidList, setAvoidList] = useState<string[]>([]);

  useEffect(() => {
    const history = localStorage.getItem('gemini_drive_history');
    if (history) setSavedPlans(JSON.parse(history));

    const storedSettings = localStorage.getItem('gemini_drive_settings');
    if (storedSettings) setSettings(JSON.parse(storedSettings));
  }, []);

  const saveSettings = () => {
    localStorage.setItem('gemini_drive_settings', JSON.stringify(settings));
    setShowSettings(false);
    alert("设置已保存！");
  };

  // --- Add/Avoid Logic ---
  const addMustVisit = () => {
    if (mustVisitInput.trim()) {
      setMustVisitList([...mustVisitList, mustVisitInput.trim()]);
      setMustVisitInput("");
    }
  };
  const removeMustVisit = (idx: number) => {
    setMustVisitList(mustVisitList.filter((_, i) => i !== idx));
  };
  const addAvoid = () => {
    if (avoidInput.trim()) {
      setAvoidList([...avoidList, avoidInput.trim()]);
      setAvoidInput("");
    }
  };
  const removeAvoid = (idx: number) => {
    setAvoidList(avoidList.filter((_, i) => i !== idx));
  };

  // --- Time & Day Logic ---

  const calculateDaysDiff = (s: string, e: string) => {
    const startD = new Date(s);
    const endD = new Date(e);
    if (isNaN(startD.getTime()) || isNaN(endD.getTime())) return 1;
    const diff = endD.getTime() - startD.getTime();
    return Math.max(1, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  };

  const calculateEndTimeFromDays = (startStr: string, numDays: number) => {
    const s = new Date(startStr);
    const e = new Date(s.getTime() + numDays * 24 * 60 * 60 * 1000);
    return formatBeijingDate(e);
  };

  const handleStartTimeChange = (val: string) => {
    setStartTime(val);
    setEndTime(calculateEndTimeFromDays(val, days));
  };

  const handleEndTimeChange = (val: string) => {
    setEndTime(val);
    setDays(calculateDaysDiff(startTime, val));
  };

  const handleDaysChange = (newDays: number) => {
    const d = Math.max(1, newDays);
    setDays(d);
    setEndTime(calculateEndTimeFromDays(startTime, d));
  };

  const handleTimePreset = (target: 'start' | 'end', type: 'now' | 'noon' | 'dinner' | 'night') => {
    const currentVal = target === 'start' ? startTime : endTime;
    let dateObj = new Date(currentVal);
    if(isNaN(dateObj.getTime())) dateObj = new Date();

    const now = new Date();
    let newStr = "";

    if (type === 'now') {
        newStr = formatBeijingDate(now);
    } else {
        let h = 12, m = 0;
        if (type === 'dinner') h = 18;
        if (type === 'night') h = 23;
        dateObj.setHours(h, m);
        newStr = formatBeijingDate(dateObj);
    }

    if (target === 'start') {
        const newStartDt = new Date(newStr);
        const currentEndDt = new Date(endTime);
        if (newStartDt < currentEndDt) {
            setStartTime(newStr);
            setDays(calculateDaysDiff(newStr, endTime));
        } else {
            setStartTime(newStr);
            setEndTime(calculateEndTimeFromDays(newStr, days));
        }
    } else {
        setEndTime(newStr);
        setDays(calculateDaysDiff(startTime, newStr));
    }
  };

  // --- Location Logic ---

  const handleLocateMe = () => {
    if (!navigator.geolocation) { alert("不支持定位"); return; }
    setIsLocating(true);
    const success = (position: any) => {
      const { latitude, longitude } = position.coords;
      const latLngStr = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
      if (typeof google !== 'undefined' && google.maps) {
        const geocoder = new google.maps.Geocoder();
        geocoder.geocode({ location: { lat: latitude, lng: longitude } }, (results: any, status: any) => {
          if (status === "OK" && results[0]) {
            let city = "";
            for (const comp of results[0].address_components) {
              if (comp.types.includes("locality")) city = comp.long_name;
              if (!city && comp.types.includes("administrative_area_level_2")) city = comp.long_name;
            }
            setStart(city || latLngStr);
            fetchRecommendations(city || latLngStr);
          } else {
            setStart(latLngStr);
            fetchRecommendations(latLngStr);
          }
          setIsLocating(false);
        });
      } else {
        setStart(latLngStr);
        fetchRecommendations(latLngStr);
        setIsLocating(false);
      }
    };
    const error = () => { alert("定位失败，请检查权限"); setIsLocating(false); };
    navigator.geolocation.getCurrentPosition(success, error);
  };

  const fetchRecommendations = async (origin: string) => {
    setIsLoadingRecs(true);
    try {
      const recs = await recommendDestinations(origin);
      setRecommendedDestinations(recs);
    } catch (e) { console.error(e); } finally { setIsLoadingRecs(false); }
  };

  const handleGenerate = async () => {
    setIsLoading(true);
    try {
      const newPlan = await generateTravelPlan({
        start, end, startTime, endTime, days, travelers, isRoundTrip, pacing, includeAccom, accommodationType, hotelBudget,
        mustVisit: mustVisitList,
        avoid: avoidList
      });
      setPlan(newPlan);
      setIsFormExpanded(false);
      prefetchAlternatives(newPlan);
    } catch (e: any) {
      alert("生成失败: " + e.message);
    } finally {
      setIsLoading(false);
    }
  };

  const prefetchAlternatives = (currentPlan: TravelPlan) => {
    currentPlan.days.forEach((day, dIdx) => {
      day.points.forEach((point, pIdx) => {
        requestQueue.add(async () => {
          try {
             const alts = await getAlternativePoints(point.name, point.type);
             setPlan(prevPlan => {
               if (!prevPlan) return null;
               const newDays = [...prevPlan.days];
               if (newDays[dIdx] && newDays[dIdx].points[pIdx]) {
                  const newPoints = [...newDays[dIdx].points];
                  newPoints[pIdx] = { ...newPoints[pIdx], alternatives: alts };
                  newDays[dIdx] = { ...newDays[dIdx], points: newPoints };
               }
               return { ...prevPlan, days: newDays };
             });
          } catch(err) {
            console.warn(`Failed to fetch alternatives for ${point.name}`, err);
          }
        });
      });
    });
  };

  // Google Places Fetcher & Lightbox (Same as before)
  const fetchGooglePlaceDetails = (point: LocationPoint) => {
    if (typeof google === 'undefined' || !google.maps || !google.maps.places) return;
    let dummyNode = document.createElement('div');
    const service = new google.maps.places.PlacesService(dummyNode);
    setIsLoadingDetails(true);
    service.findPlaceFromQuery({ query: point.name, fields: ['photos', 'reviews', 'place_id'] }, (results: any[], status: any) => {
      if (status === google.maps.places.PlacesServiceStatus.OK && results && results[0]) {
         service.getDetails({ placeId: results[0].place_id, fields: ['photos', 'reviews'] }, (place: any, status: any) => {
             setIsLoadingDetails(false);
             if (status === google.maps.places.PlacesServiceStatus.OK) {
                 const photos = place.photos?.slice(0, 4).map((p: any) => p.getUrl({ maxWidth: 1024, maxHeight: 768 })) || [];
                 const reviews = place.reviews?.slice(0, 4).map((r: any) => r.text) || [];
                 setSelectedPoint(prev => prev ? ({ ...prev, photos, reviews }) : null);
             }
         });
      } else { setIsLoadingDetails(false); }
    });
  };

  const handlePointClick = (pt: LocationPoint) => { setSelectedPoint(pt); fetchGooglePlaceDetails(pt); };
  const handleReplaceClick = (e: React.MouseEvent, pt: LocationPoint, dIdx: number, pIdx: number) => {
    e.stopPropagation();
    if (pt.alternatives && pt.alternatives.length > 0) {
      setAlternatives(pt.alternatives);
      setShowAlternatives({ point: pt, dayIdx: dIdx, pointIdx: pIdx });
    } else {
      setShowAlternatives({ point: pt, dayIdx: dIdx, pointIdx: pIdx });
      setIsLoadingAlts(true);
      getAlternativePoints(pt.name, pt.type).then(alts => {
         setAlternatives(alts);
         setIsLoadingAlts(false);
         setPlan(prev => {
             if (!prev) return null;
             const newDays = [...prev.days];
             const newPoints = [...newDays[dIdx].points];
             newPoints[pIdx] = { ...newPoints[pIdx], alternatives: alts };
             newDays[dIdx] = { ...newDays[dIdx], points: newPoints };
             return { ...prev, days: newDays };
         });
      });
    }
  };

  const confirmReplace = (alt: any) => {
    if (!showAlternatives || !plan) return;
    const { dayIdx, pointIdx } = showAlternatives;
    const newPlan = { ...plan };
    const oldPoint = newPlan.days[dayIdx].points[pointIdx];
    const newPoint: LocationPoint = { ...oldPoint, ...alt, alternatives: [], photos: [], reviews: [] };
    const newDays = [...newPlan.days];
    newDays[dayIdx].points[pointIdx] = newPoint;
    setPlan({ ...newPlan, days: newDays });
    setShowAlternatives(null);
    setAlternatives([]);
    requestQueue.add(async () => {
         const alts = await getAlternativePoints(newPoint.name, newPoint.type);
         setPlan(curr => {
             if(!curr) return null;
             const d = [...curr.days];
             d[dayIdx].points[pointIdx].alternatives = alts;
             return { ...curr, days: d };
         })
    });
  };

  const getMapSrc = () => {
    if (!plan || plan.days.length === 0) return "";
    const points = plan.days.flatMap(d => d.points);
    if (points.length < 2) return "";
    const origin = `${points[0].lat},${points[0].lng}`;
    const destination = `${points[points.length-1].lat},${points[points.length-1].lng}`;
    if (settings.googleMapsKey) {
        const waypoints = points.slice(1, -1).map(p => `${p.lat},${p.lng}`).join('|');
        return `https://www.google.com/maps/embed/v1/directions?key=${settings.googleMapsKey}&origin=${origin}&destination=${destination}&waypoints=${waypoints}&mode=driving`;
    } else {
        const daddr = points.slice(1).map(p => `${p.lat},${p.lng}`).join('+to:');
        return `https://maps.google.com/maps?saddr=${origin}&daddr=${daddr}&ie=UTF8&output=embed`;
    }
  };

  // --- Total Cost Calculation ---
  const calculateTotalCost = (p: TravelPlan) => {
     let total = 0;
     let transport = 0;
     let accom = 0;
     let dining = 0;
     let tickets = 0;

     p.days.forEach(day => {
        // Daily Transportation (Fuel/Tolls)
        if (day.transportation_cost) {
            const tCost = parsePrice(day.transportation_cost);
            total += tCost;
            transport += tCost;
        }

        day.points.forEach(pt => {
            const cost = calculatePointCost(pt, p.travelers);
            total += cost;
            if (pt.type === 'hotel') accom += cost;
            else if (pt.type === 'restaurant') dining += cost;
            else if (pt.type === 'attraction') tickets += cost;
            else if (pt.type === 'parking') transport += cost;
        });
     });

     return { total, transport, accom, dining, tickets };
  };

  const QuickTimeButtons = ({ target }: { target: 'start' | 'end' }) => (
    <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1 mt-2">
      <button onClick={() => handleTimePreset(target, 'now')} className="px-3 py-1.5 bg-blue-50 text-blue-600 rounded-lg text-xs font-bold whitespace-nowrap border border-blue-100">现在</button>
      <button onClick={() => handleTimePreset(target, 'noon')} className="px-3 py-1.5 bg-gray-50 text-gray-600 rounded-lg text-xs font-bold whitespace-nowrap flex items-center gap-1 border border-gray-100 hover:bg-white hover:border-gray-300"><Sun className="w-3 h-3 text-orange-400"/>12:00</button>
      <button onClick={() => handleTimePreset(target, 'dinner')} className="px-3 py-1.5 bg-gray-50 text-gray-600 rounded-lg text-xs font-bold whitespace-nowrap flex items-center gap-1 border border-gray-100 hover:bg-white hover:border-gray-300"><Utensils className="w-3 h-3 text-red-400"/>18:00</button>
      <button onClick={() => handleTimePreset(target, 'night')} className="px-3 py-1.5 bg-gray-50 text-gray-600 rounded-lg text-xs font-bold whitespace-nowrap flex items-center gap-1 border border-gray-100 hover:bg-white hover:border-gray-300"><Moon className="w-3 h-3 text-indigo-400"/>23:00</button>
    </div>
  );

  const CostSummary = ({ plan }: { plan: TravelPlan }) => {
     const costs = calculateTotalCost(plan);
     return (
       <div className="mx-5 mb-8 p-5 bg-gradient-to-br from-gray-900 to-gray-800 rounded-[32px] text-white shadow-xl">
          <div className="flex items-center justify-between mb-4">
             <div className="flex items-center gap-2">
                <Receipt className="w-5 h-5 text-yellow-400"/>
                <h3 className="font-bold">行程预算总览 ({plan.travelers}人)</h3>
             </div>
             <span className="text-2xl font-bold text-yellow-400">¥{costs.total}</span>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
             <div className="bg-white/10 p-3 rounded-2xl flex justify-between items-center">
                <span className="text-gray-300">过路费/油费</span>
                <span className="font-bold">¥{costs.transport}</span>
             </div>
             <div className="bg-white/10 p-3 rounded-2xl flex justify-between items-center">
                <span className="text-gray-300">住宿费用</span>
                <span className="font-bold">¥{costs.accom}</span>
             </div>
             <div className="bg-white/10 p-3 rounded-2xl flex justify-between items-center">
                <span className="text-gray-300">餐饮美食</span>
                <span className="font-bold">¥{costs.dining}</span>
             </div>
             <div className="bg-white/10 p-3 rounded-2xl flex justify-between items-center">
                <span className="text-gray-300">门票活动</span>
                <span className="font-bold">¥{costs.tickets}</span>
             </div>
          </div>
          <div className="mt-4 pt-4 border-t border-white/10 text-center text-xs text-gray-400">
             人均约 ¥{Math.round(costs.total / plan.travelers)}
          </div>
       </div>
     );
  };

  return (
    <div className="flex flex-col min-h-screen max-w-md mx-auto bg-gray-50 relative overflow-x-hidden">
      {/* Header */}
      <header className="px-6 py-5 flex items-center justify-between sticky top-0 bg-white/80 backdrop-blur-lg z-50 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-200"><Compass className="text-white w-5 h-5" /></div>
          <h1 className="font-bold text-lg text-gray-800 tracking-tight">K-drive PRO</h1>
        </div>
        <button onClick={() => setShowSettings(true)} className="p-2 text-gray-400 hover:text-blue-600 transition-colors"><SettingsIcon className="w-5 h-5" /></button>
      </header>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100] flex items-center justify-center p-6 animate-in fade-in duration-200">
          <div className="bg-white w-full rounded-[32px] p-6 shadow-2xl animate-in zoom-in-95 duration-200 max-h-[85vh] overflow-y-auto no-scrollbar">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-gray-800">设置</h2>
              <button onClick={() => setShowSettings(false)} className="p-2 bg-gray-50 rounded-full text-gray-400 hover:bg-gray-100"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-6">
              <div className="space-y-3">
                <h3 className="text-sm font-bold text-blue-600 uppercase tracking-widest">AI 配置 (Gemini)</h3>
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1 ml-1">API Key</label>
                  <input type="password" value={settings.apiKey} onChange={(e) => setSettings({...settings, apiKey: e.target.value})} className="w-full px-4 py-3 bg-gray-50 rounded-xl border border-transparent focus:border-blue-500 focus:bg-white outline-none transition-all text-sm font-medium" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1 ml-1">Base URL</label>
                  <input type="text" value={settings.baseUrl} onChange={(e) => setSettings({...settings, baseUrl: e.target.value})} className="w-full px-4 py-3 bg-gray-50 rounded-xl border border-transparent focus:border-blue-500 focus:bg-white outline-none transition-all text-sm font-medium" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-400 uppercase mb-1 ml-1">Model</label>
                  <input type="text" value={settings.model} onChange={(e) => setSettings({...settings, model: e.target.value})} className="w-full px-4 py-3 bg-gray-50 rounded-xl border border-transparent focus:border-blue-500 focus:bg-white outline-none transition-all text-sm font-medium" />
                </div>
              </div>
              <button onClick={saveSettings} className="w-full bg-blue-600 text-white font-bold py-3.5 rounded-2xl shadow-lg shadow-blue-200 active:scale-95 transition-all mt-4">保存设置</button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {lightboxImage && (
        <div className="fixed inset-0 bg-black z-[200] flex items-center justify-center animate-in fade-in duration-200" onClick={() => setLightboxImage(null)}>
           <img src={lightboxImage} alt="Full View" className="max-w-full max-h-full object-contain" />
           <button className="absolute top-4 right-4 text-white p-2 bg-white/10 rounded-full"><X className="w-6 h-6"/></button>
        </div>
      )}

      <main className="flex-1 pb-32">
        <section className="p-4">
          <div className="bg-white rounded-[32px] shadow-sm border border-gray-100 overflow-hidden">
            <button onClick={() => setIsFormExpanded(!isFormExpanded)} className="w-full px-6 py-4 flex items-center justify-between text-gray-700 font-bold">
              <div className="flex items-center gap-2"><Search className="w-4 h-4 text-blue-500" /><span>{plan ? "查看路线设置" : "规划你的旅程"}</span></div>
              {isFormExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
            </button>
            {isFormExpanded && (
              <div className="px-6 pb-6 space-y-5 animate-in slide-in-from-top-2 duration-300">
                <div className="space-y-4">
                   <div className="flex gap-3">
                    <div className="flex-1 relative">
                      <MapPin className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-blue-500" />
                      <input value={start} onChange={e => setStart(e.target.value)} className="w-full pl-11 pr-4 py-3 bg-gray-50 rounded-2xl border-none outline-none text-sm font-medium" placeholder="起点" />
                      <button onClick={handleLocateMe} className="absolute right-2 top-1/2 -translate-y-1/2 p-2 bg-blue-50 rounded-xl text-blue-600 hover:bg-blue-100 transition-colors">
                        {isLocating ? <Loader2 className="w-4 h-4 animate-spin"/> : <LocateFixed className="w-4 h-4"/>}
                      </button>
                    </div>
                  </div>
                  <div className="flex-1 relative">
                      <MapPin className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-red-500" />
                      <input value={end} onChange={e => setEnd(e.target.value)} className="w-full pl-11 pr-4 py-3 bg-gray-50 rounded-2xl border-none outline-none text-sm font-medium" placeholder="终点" />
                  </div>
                  {!isLoadingRecs && recommendedDestinations.length > 0 && (
                    <div className="flex flex-wrap gap-2 animate-in fade-in slide-in-from-top-2">
                      <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center h-6">周边好去处 ({'>'}300km):</span>
                      {recommendedDestinations.map(city => (
                        <button key={city} onClick={() => setEnd(city)} className="px-3 py-1 bg-orange-50 text-orange-600 rounded-lg text-xs font-bold border border-orange-100 transition-colors hover:bg-orange-100">{city}</button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="h-px bg-gray-100 w-full" />
                
                <div className="space-y-2">
                   <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center gap-1"><Clock className="w-3 h-3" />出发时间</label>
                   <input type="datetime-local" value={startTime} onChange={e => handleStartTimeChange(e.target.value)} className="w-full px-4 py-3 bg-gray-50 rounded-2xl border-none outline-none text-sm font-medium" />
                   <QuickTimeButtons target="start" />
                </div>

                {/* Travelers Count */}
                <div className="space-y-2">
                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center gap-1"><Users className="w-3 h-3" />出行人数</label>
                    <div className="flex items-center justify-between bg-gray-50 p-1 rounded-2xl">
                      <button onClick={() => setTravelers(Math.max(1, travelers - 1))} className="p-3 hover:bg-white rounded-xl transition-all shadow-sm"><Minus className="w-4 h-4" /></button>
                      <span className="font-bold text-gray-800">{travelers} 人</span>
                      <button onClick={() => setTravelers(travelers + 1)} className="p-3 hover:bg-white rounded-xl transition-all shadow-sm"><Plus className="w-4 h-4" /></button>
                    </div>
                </div>

                <div className="space-y-2">
                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">游玩天数</label>
                    <div className="flex items-center justify-between bg-gray-50 p-1 rounded-2xl">
                      <button onClick={() => handleDaysChange(Math.max(1, days - 1))} className="p-2 hover:bg-white rounded-xl transition-all"><Minus className="w-4 h-4" /></button>
                      <span className="font-bold text-blue-600">{days} 天</span>
                      <button onClick={() => handleDaysChange(days + 1)} className="p-2 hover:bg-white rounded-xl transition-all"><Plus className="w-4 h-4" /></button>
                    </div>
                </div>

                 <div className="space-y-2">
                   <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center gap-1"><Watch className="w-3 h-3" />结束时间</label>
                   <input type="datetime-local" value={endTime} onChange={e => handleEndTimeChange(e.target.value)} className="w-full px-4 py-3 bg-gray-50 rounded-2xl border-none outline-none text-sm font-medium" />
                   <QuickTimeButtons target="end" />
                </div>

                {/* Must Visit / Avoid Section */}
                <div className="grid grid-cols-1 gap-4 pt-2 border-t border-gray-50">
                  <div className="space-y-2">
                     <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center gap-1"><Heart className="w-3 h-3 text-red-500" />添加 (必去景点/门店)</label>
                     <div className="flex gap-2">
                       <input value={mustVisitInput} onChange={e => setMustVisitInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && addMustVisit()} className="flex-1 px-4 py-2 bg-gray-50 rounded-xl text-sm border-none outline-none" placeholder="输入名称..." />
                       <button onClick={addMustVisit} className="px-4 bg-red-50 text-red-600 rounded-xl font-bold text-sm hover:bg-red-100"><Plus className="w-4 h-4"/></button>
                     </div>
                     <div className="flex flex-wrap gap-2">
                        {mustVisitList.map((item, i) => (
                           <span key={i} className="inline-flex items-center gap-1 px-2 py-1 bg-red-50 text-red-600 rounded-lg text-xs font-bold border border-red-100">
                             {item} <X className="w-3 h-3 cursor-pointer" onClick={() => removeMustVisit(i)} />
                           </span>
                        ))}
                     </div>
                  </div>

                   <div className="space-y-2">
                     <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center gap-1"><AlertTriangle className="w-3 h-3 text-gray-500" />避雷 (不去/拉黑)</label>
                     <div className="flex gap-2">
                       <input value={avoidInput} onChange={e => setAvoidInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && addAvoid()} className="flex-1 px-4 py-2 bg-gray-50 rounded-xl text-sm border-none outline-none" placeholder="输入名称/城市..." />
                       <button onClick={addAvoid} className="px-4 bg-gray-100 text-gray-600 rounded-xl font-bold text-sm hover:bg-gray-200"><Plus className="w-4 h-4"/></button>
                     </div>
                     <div className="flex flex-wrap gap-2">
                        {avoidList.map((item, i) => (
                           <span key={i} className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-500 rounded-lg text-xs font-bold border border-gray-200">
                             {item} <X className="w-3 h-3 cursor-pointer" onClick={() => removeAvoid(i)} />
                           </span>
                        ))}
                     </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">行程模式</label>
                    <button onClick={() => setIsRoundTrip(!isRoundTrip)} className={`w-full py-3 rounded-2xl text-xs font-bold transition-all ${isRoundTrip ? 'bg-blue-600 text-white shadow-lg shadow-blue-100' : 'bg-gray-100 text-gray-400'}`}>{isRoundTrip ? '往返路线' : '单程路线'}</button>
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">游玩节奏</label>
                    <div className="flex bg-gray-100 p-1 rounded-2xl h-[42px]">
                      {Object.values(Pacing).map(p => (
                        <button key={p} onClick={() => setPacing(p)} className={`flex-1 text-[10px] font-bold rounded-xl transition-all ${pacing === p ? 'bg-white text-blue-600 shadow-sm h-full' : 'text-gray-400'}`}>{p}</button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="pt-2 border-t border-gray-50 space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-gray-700">自动规划食宿</span>
                    <button onClick={() => setIncludeAccom(!includeAccom)} className={`w-12 h-6 rounded-full transition-colors relative ${includeAccom ? 'bg-blue-600' : 'bg-gray-200'}`}><div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${includeAccom ? 'translate-x-7' : 'translate-x-1'}`} /></button>
                  </div>
                  {includeAccom && (
                    <div className="space-y-4 animate-in fade-in duration-300">
                      <div className="flex bg-gray-100 p-1 rounded-2xl">
                        <button onClick={() => setAccommodationType(AccommodationType.HOTEL)} className={`flex-1 py-2 text-xs font-bold rounded-xl transition-all ${accommodationType === AccommodationType.HOTEL ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-400'}`}>酒店</button>
                        <button onClick={() => setAccommodationType(AccommodationType.CAR)} className={`flex-1 py-2 text-xs font-bold rounded-xl transition-all ${accommodationType === AccommodationType.CAR ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-400'}`}>车住</button>
                      </div>
                      {accommodationType === AccommodationType.HOTEL && (
                        <div className="space-y-2">
                          <div className="flex justify-between text-[10px] font-bold text-gray-400"><span>每晚预算</span><span className="text-blue-600">￥{hotelBudget}</span></div>
                          <input type="range" min="100" max="2000" step="100" value={hotelBudget} onChange={e => setHotelBudget(Number(e.target.value))} className="w-full h-1 bg-gray-200 rounded-full appearance-none accent-blue-600" />
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <button onClick={handleGenerate} disabled={isLoading} className="w-full bg-blue-600 text-white font-bold py-4 rounded-3xl flex items-center justify-center gap-2 shadow-xl shadow-blue-100 active:scale-95 transition-all disabled:opacity-50">
                  {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Navigation className="w-5 h-5 fill-current" />}
                  {isLoading ? "规划方案中..." : "生成智能自驾路线"}
                </button>
              </div>
            )}
          </div>
        </section>

        {/* Itinerary List */}
        {plan && viewMode === 'list' && (
          <div className="px-5 space-y-8 mt-4 animate-in slide-in-from-bottom-4 duration-500">
            {plan.days.map((day, dIdx) => (
              <div key={dIdx} className="space-y-6">
                <div className="flex items-center gap-3 justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 bg-gray-800 text-white rounded-2xl flex items-center justify-center font-bold text-lg shadow-lg">D{day.day}</div>
                    <div>
                        <h3 className="font-bold text-gray-800">{day.date}</h3>
                        <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">行程概要</p>
                    </div>
                  </div>
                  {day.transportation_cost && (
                      <div className="text-right">
                          <span className="block text-[10px] text-gray-400 font-bold uppercase">预计路费</span>
                          <span className="text-xs font-bold text-gray-700 bg-gray-100 px-2 py-1 rounded-lg">{day.transportation_cost}</span>
                      </div>
                  )}
                </div>
                
                <div className="relative ml-6 pl-8 border-l-2 border-dashed border-gray-200 space-y-8">
                  {day.points.map((pt, pIdx) => {
                    const pointCost = calculatePointCost(pt, plan.travelers);
                    const cardImages = getRealImages(pt.name, pt.type);
                    
                    return (
                    <div key={pIdx} className="relative">
                      <div className={`absolute -left-[45px] top-1 w-8 h-8 rounded-full border-4 border-white shadow-md z-10 flex items-center justify-center ${pt.type === 'restaurant' ? 'bg-orange-500' : pt.type === 'parking' ? 'bg-indigo-600' : 'bg-blue-600'}`}>
                        {pt.type === 'restaurant' ? <Utensils className="w-4 h-4 text-white" /> : <MapPin className="w-4 h-4 text-white" />}
                      </div>

                      <div onClick={() => handlePointClick(pt)} className="bg-white p-5 rounded-[32px] shadow-sm border border-gray-100 hover:border-blue-200 transition-all cursor-pointer group">
                        <div className="flex justify-between items-start mb-2">
                          <div>
                            <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded-lg">{pt.arrivalTime} 到达</span>
                            <h4 className="font-bold text-gray-800 text-base mt-2 group-hover:text-blue-600 transition-colors">{pt.name}</h4>
                          </div>
                          <button onClick={(e) => handleReplaceClick(e, pt, dIdx, pIdx)} className="p-2 text-gray-300 hover:text-blue-600 hover:bg-blue-50 rounded-xl transition-all">
                            <RefreshCw className={`w-4 h-4 ${!pt.alternatives ? 'opacity-50' : ''}`} />
                          </button>
                        </div>

                        {/* 4 Representative Images Grid */}
                        <div className="grid grid-cols-4 gap-2 mb-3 h-16 w-full">
                           {cardImages.map((imgUrl, i) => (
                             <div key={i} className="relative w-full h-full rounded-xl overflow-hidden bg-gray-100" onClick={(e) => { e.stopPropagation(); setLightboxImage(imgUrl); }}>
                                <img src={imgUrl} loading="lazy" className="w-full h-full object-cover transform hover:scale-110 transition-transform duration-500" alt={`${pt.name} ${i}`} onError={(e) => { (e.target as HTMLImageElement).src = 'https://via.placeholder.com/400x300?text=No+Image'; }} />
                             </div>
                           ))}
                        </div>
                        
                        <div className="flex gap-2 mb-3 flex-wrap">
                          {pt.duration && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-gray-500 bg-gray-100 px-2 py-1 rounded-md">
                              <Clock className="w-3 h-3" /> {pt.duration}
                            </span>
                          )}
                          {/* Cost Badge */}
                          {pointCost > 0 && (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-yellow-600 bg-yellow-50 px-2 py-1 rounded-md">
                              <Receipt className="w-3 h-3" /> 小计: ¥{pointCost}
                            </span>
                          )}
                        </div>

                        <p className="text-xs text-gray-500 leading-relaxed line-clamp-2">{pt.description}</p>
                        <div className="flex items-center gap-4 mt-4 pt-4 border-t border-gray-50">
                          <div className="flex items-center gap-1 text-xs text-orange-500 font-bold"><Star className="w-3 h-3 fill-current" /><span>{pt.rating}</span></div>
                          <span className="text-[10px] text-gray-400 font-medium">({pt.user_ratings_total} 评价)</span>
                          {pt.travelTimeToNext && (
                            <div className="ml-auto text-[10px] font-bold text-gray-400 flex items-center gap-1"><ArrowRight className="w-3 h-3" /> 行驶 {pt.travelTimeToNext}</div>
                          )}
                        </div>
                      </div>
                    </div>
                  )})}
                </div>
              </div>
            ))}
            
            {/* Cost Summary Footer */}
            <CostSummary plan={plan} />

          </div>
        )}

        {/* Full Map Mode with Iframe */}
        {viewMode === 'map' && (
          <div className="fixed inset-0 z-40 bg-gray-100 flex flex-col">
            {plan && plan.days.length > 0 ? (
                <iframe 
                    src={getMapSrc()} 
                    className="w-full h-full border-0" 
                    allowFullScreen 
                    loading="lazy"
                    title="Google Maps Route"
                />
            ) : (
                <div className="flex items-center justify-center h-full text-gray-400">暂无路线数据</div>
            )}
            <button onClick={() => setViewMode('list')} className="absolute top-6 right-6 w-10 h-10 bg-white rounded-full flex items-center justify-center shadow-lg text-gray-600"><X className="w-5 h-5" /></button>
          </div>
        )}
      </main>

      {/* Navigation Tabs */}
      <nav className="fixed bottom-0 left-0 right-0 max-w-md mx-auto glass border-t border-white/50 px-12 py-6 flex justify-around items-center z-[60] safe-bottom rounded-t-[40px] shadow-2xl">
        <button onClick={() => plan && setViewMode('list')} className={`flex flex-col items-center gap-1 transition-all ${viewMode === 'list' ? 'text-blue-600 scale-110' : 'text-gray-400'}`}><ListIcon className="w-6 h-6" /><span className="text-[10px] font-bold uppercase">清单</span></button>
        <button onClick={() => plan && setViewMode('map')} className={`flex flex-col items-center gap-1 transition-all ${viewMode === 'map' ? 'text-blue-600 scale-110' : 'text-gray-400'}`}><MapIcon className="w-6 h-6" /><span className="text-[10px] font-bold uppercase">地图</span></button>
        <button onClick={() => { const h = [plan, ...savedPlans].filter(Boolean); setSavedPlans(h as any); localStorage.setItem('gemini_drive_history', JSON.stringify(h)); alert("方案已保存"); }} className="flex flex-col items-center gap-1 text-gray-400"><Save className="w-6 h-6" /><span className="text-[10px] font-bold uppercase">保存</span></button>
      </nav>

      {/* Details Sheet */}
      {selectedPoint && !showAlternatives && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-md z-[110] flex items-center justify-center p-6 animate-in fade-in duration-200">
          <div className="bg-white w-full h-[85vh] rounded-[48px] overflow-hidden shadow-2xl animate-in slide-in-from-bottom-10 duration-300 flex flex-col">
             {/* Lightbox/Photos Header with Generated Fallback */}
             <div className="relative h-64 bg-gray-100 flex-shrink-0">
               {/* Use Google Photos if available, otherwise use generated ones */}
               {(() => {
                 const displayPhotos = (selectedPoint.photos && selectedPoint.photos.length > 0) ? selectedPoint.photos : getRealImages(selectedPoint.name, selectedPoint.type);
                 return (
                   <div className="w-full h-full flex overflow-x-auto no-scrollbar snap-x snap-mandatory">
                     {displayPhotos.map((url, i) => (
                       <div key={i} className="w-full h-full flex-shrink-0 snap-center relative" onClick={() => setLightboxImage(url)}>
                          <img src={url} className="w-full h-full object-cover" alt={`Photo ${i}`} onError={(e) => { (e.target as HTMLImageElement).src = 'https://via.placeholder.com/800x600?text=Image+Unavailable'; }} />
                          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-black/30 rounded-full p-2 opacity-0 hover:opacity-100 transition-opacity pointer-events-none"><Maximize2 className="w-8 h-8 text-white"/></div>
                       </div>
                     ))}
                     <div className="absolute bottom-4 right-4 bg-black/50 text-white text-xs px-2 py-1 rounded-lg backdrop-blur-sm flex items-center gap-1 pointer-events-none"><ImageIcon className="w-3 h-3"/> {displayPhotos.length} 张图片 (点击查看)</div>
                   </div>
                 );
               })()}
              <button onClick={() => setSelectedPoint(null)} className="absolute top-6 right-6 w-10 h-10 bg-white/20 backdrop-blur-md rounded-full flex items-center justify-center text-white border border-white/30 hover:bg-white hover:text-gray-800 transition-all z-10"><X className="w-5 h-5"/></button>
            </div>

            <div className="flex-1 overflow-y-auto p-8">
              <div className="mb-4">
                <h3 className="text-2xl font-bold text-gray-800">{selectedPoint.name}</h3>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <div className="flex items-center gap-1 text-orange-500 font-bold bg-orange-50 px-2 py-1 rounded-lg text-sm"><Star className="w-4 h-4 fill-current" /><span>{selectedPoint.rating}</span></div>
                  <span className="text-gray-400 text-sm">({selectedPoint.user_ratings_total} 条评价)</span>
                  {isLoadingDetails && <Loader2 className="w-4 h-4 animate-spin text-blue-500" />}
                </div>
              </div>

              <div className="flex gap-3 mb-6 flex-wrap">
                  {selectedPoint.duration && <div className="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-xl text-xs font-medium text-gray-600"><Clock className="w-4 h-4 text-blue-500" /><span>{selectedPoint.duration}</span></div>}
                  {selectedPoint.ticket_price && <div className="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-xl text-xs font-medium text-gray-600"><Ticket className="w-4 h-4 text-indigo-500" /><span>{selectedPoint.ticket_price}</span></div>}
                  {selectedPoint.average_cost && <div className="flex items-center gap-2 bg-gray-50 px-3 py-2 rounded-xl text-xs font-medium text-gray-600"><Banknote className="w-4 h-4 text-green-500" /><span>{selectedPoint.average_cost}</span></div>}
              </div>

              <div className="space-y-6">
                <div><h4 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-2">简介</h4><p className="text-gray-600 text-sm leading-relaxed">{selectedPoint.description}</p></div>
                <div><h4 className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-3 flex items-center gap-2"><MessageSquare className="w-3 h-3"/> 精选评价 (来源: Google Maps)</h4>
                   {selectedPoint.reviews && selectedPoint.reviews.length > 0 ? (
                     <div className="space-y-3">{selectedPoint.reviews.map((review, i) => (<div key={i} className="bg-gray-50 p-4 rounded-2xl text-xs text-gray-600 leading-relaxed italic border border-gray-100">"{review.length > 120 ? review.substring(0, 120) + '...' : review}"</div>))}</div>
                   ) : (<div className="text-center py-4 text-gray-400 text-xs italic bg-gray-50 rounded-2xl border border-dashed border-gray-200">{isLoadingDetails ? "正在加载评价..." : "暂无评价显示"}</div>)}
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-gray-50 flex-shrink-0"><a href={`https://www.google.com/maps/search/?api=1&query=${selectedPoint.lat},${selectedPoint.lng}`} target="_blank" className="w-full bg-blue-600 text-white font-bold py-4 rounded-3xl flex items-center justify-center gap-2 shadow-xl shadow-blue-100 active:scale-95 transition-all"><Navigation className="w-5 h-5" />谷歌地图导航</a></div>
          </div>
        </div>
      )}

      {showAlternatives && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[120] flex items-end justify-center">
          <div className="bg-white w-full rounded-t-[48px] p-8 animate-in slide-in-from-bottom-full duration-500 max-h-[80vh] overflow-y-auto no-scrollbar">
            <div className="flex justify-between items-center mb-8"><div><h3 className="text-xl font-bold text-gray-800">更换地点</h3><p className="text-xs text-gray-400 mt-1">寻找更适合你的目的地</p></div><button onClick={() => setShowAlternatives(null)} className="p-2 bg-gray-50 rounded-full text-gray-400"><X className="w-5 h-5"/></button></div>
            <div className="space-y-4">
              {isLoadingAlts && alternatives.length === 0 ? (
                <div className="py-20 flex flex-col items-center gap-4 text-gray-300"><Loader2 className="w-10 h-10 animate-spin text-blue-600" /><p className="font-bold text-sm">正在搜寻周边高分地点...</p></div>
              ) : alternatives.map((alt, i) => (
                <div key={i} onClick={() => confirmReplace(alt)} className="p-5 bg-gray-50 rounded-[32px] border border-transparent hover:border-blue-200 transition-all cursor-pointer flex items-center justify-between group active:scale-95">
                  <div className="flex-1 pr-4">
                    <h4 className="font-bold text-gray-800 group-hover:text-blue-600 transition-colors">{alt.name}</h4>
                    <p className="text-[10px] text-gray-400 line-clamp-1 mt-1">{alt.description}</p>
                    <div className="flex gap-2 mt-2 flex-wrap">{alt.ticket_price && <span className="text-[9px] bg-indigo-50 text-indigo-500 px-1.5 py-0.5 rounded flex items-center gap-0.5"><Ticket className="w-2 h-2"/>{alt.ticket_price}</span>}{alt.average_cost && <span className="text-[9px] bg-green-50 text-green-600 px-1.5 py-0.5 rounded flex items-center gap-0.5"><Banknote className="w-2 h-2"/>{alt.average_cost}</span>}</div>
                    <div className="flex items-center gap-2 mt-2"><div className="flex items-center gap-1 text-[10px] text-orange-500 font-bold"><Star className="w-3 h-3 fill-current" />{alt.rating}</div><span className="text-[10px] text-gray-400">({alt.user_ratings_total} 评价)</span></div>
                  </div>
                  <div className="w-10 h-10 bg-white rounded-2xl flex items-center justify-center text-blue-600 shadow-sm border border-gray-100"><Check className="w-5 h-5" /></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
