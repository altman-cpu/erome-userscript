import { useCallback, useEffect, useRef, useState } from 'react';

/* Text-to-speech narration built on the Web Speech API.
 * - loads the system voice list (async in most browsers)
 * - keeps a small backlog cap so narration never falls behind the terminal
 * - `speak(text, { force })` skips while disabled unless forced
 */
export function useTTS() {
  const supported =
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance !== 'undefined';

  const [enabled, setEnabled] = useState(false);
  const [voices, setVoices] = useState([]);
  const [voiceURI, setVoiceURI] = useState('');
  const [rate, setRate] = useState(1.05);
  const [spokenCount, setSpokenCount] = useState(0);
  const activeRef = useRef(0);

  useEffect(() => {
    if (!supported) return undefined;
    const load = () => {
      const list = window.speechSynthesis.getVoices();
      if (list.length) {
        setVoices(list);
        setVoiceURI((current) => current || (list.find((v) => v.default) || list[0]).voiceURI);
      }
    };
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, [supported]);

  const speak = useCallback((text, { force = false } = {}) => {
    if (!supported || (!enabled && !force)) return;
    if (activeRef.current >= 3) return; // narration backlog cap
    const utterance = new SpeechSynthesisUtterance(String(text).slice(0, 240));
    const voice = window.speechSynthesis.getVoices().find((v) => v.voiceURI === voiceURI);
    if (voice) utterance.voice = voice;
    utterance.rate = rate;
    utterance.onstart = () => {
      activeRef.current += 1;
    };
    const done = () => {
      activeRef.current = Math.max(0, activeRef.current - 1);
    };
    utterance.onend = done;
    utterance.onerror = done;
    window.speechSynthesis.speak(utterance);
    setSpokenCount((count) => count + 1);
  }, [supported, enabled, rate, voiceURI]);

  return {
    supported,
    enabled,
    setEnabled,
    voices,
    voiceURI,
    setVoiceURI,
    rate,
    setRate,
    speak,
    spokenCount,
  };
}
