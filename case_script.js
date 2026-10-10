// ==========================================
// 1. SMOOTH SCROLLING (LENIS)
// ==========================================
const lenis = new Lenis({
  lerp: 0.05,
  wheelMultiplier: 2,
  smoothWheel: true,
});

function raf(time) {
  lenis.raf(time);
  requestAnimationFrame(raf);
}
requestAnimationFrame(raf);


// ==========================================
// 2. VIEWPORT HEIGHT FIX (MOBILE)
// ==========================================
function setStaticViewportHeight() {
  const vh = window.innerHeight * 0.01;
  document.documentElement.style.setProperty('--vh', `${vh}px`);
}

setStaticViewportHeight();
let currentWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth !== currentWidth) {
    currentWidth = window.innerWidth;
    setStaticViewportHeight();
  }
});


// ==========================================
// 3. THEME MANAGEMENT (DARK/LIGHT)
// ==========================================
function updateThemeImages(isDark) {
  const theme = isDark ? 'dark' : 'light';
  document.querySelectorAll('.navicon').forEach(img => {
    img.src = `../assets/navicon_${theme}_anim.webp`;
  });
}

function applySavedTheme() {
  const isDark = localStorage.getItem('site-theme') !== 'light';
  document.documentElement.classList.toggle('dark-theme', isDark);
  updateThemeImages(isDark);
}

function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark-theme');
  localStorage.setItem('site-theme', isDark ? 'dark' : 'light');
  updateThemeImages(isDark);
}


// ==========================================
// 4. MOBILE VIDEO SWAP
// ==========================================
// Give a video data-mobile-src="assets/your-mobile-video.mp4" (and optionally
// data-mobile-poster) to play a different file below 1000px, the same
// breakpoint as the responsive CSS. Videos without it are left alone.
// Meant for videos that load straight away, like the hero.
const mobileQuery = window.matchMedia('(max-width: 1000px)');

function updateMobileVideos() {
  document.querySelectorAll('video[data-mobile-src]').forEach(video => {
    // Remember the desktop files the first time round
    if (!video.dataset.desktopSrc) {
      video.dataset.desktopSrc = video.getAttribute('src');
      video.dataset.desktopPoster = video.getAttribute('poster') || '';
    }

    const isMobile = mobileQuery.matches;
    const src = isMobile ? video.dataset.mobileSrc : video.dataset.desktopSrc;
    const poster = isMobile ? (video.dataset.mobilePoster || video.dataset.desktopPoster) : video.dataset.desktopPoster;

    if (video.getAttribute('src') !== src) {
      video.poster = poster;
      video.src = src;
      if (video.autoplay) video.play().catch(() => {});
    }
  });
}

mobileQuery.addEventListener('change', updateMobileVideos);


// ==========================================
// 5. INTERSECTION OBSERVERS (ANIMATIONS & LAZY LOAD)
// ==========================================
const scrollInObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add("show");
    } else {
      entry.target.classList.remove("show");
    }
  });
}, { threshold: 0.1 });


// Video Lazy Loader
function loadVideo(video) {
  if (video && video.hasAttribute('data-src')) {
    video.src = video.getAttribute('data-src');
    video.removeAttribute('data-src');
    video.load();
  }
}

const workVideoObserver = new IntersectionObserver((entries, observer) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      loadVideo(entry.target.querySelector('video[data-src]'));
      observer.unobserve(entry.target);
    }
  });
}, { rootMargin: "0px 0px 200px 0px" });


// ==========================================
// 6. SWAP GROUPS: CLICK A SMALL TILE TO MAKE IT THE LARGE ONE
// ==========================================
// A small tile swaps with the .supporting-large in its own .swap-group.
// Clicking the large tile (or any tile on mobile, where there is no large one) toggles its sound.
function handleSupportingClick(item) {
  const large = item.closest('.swap-group').querySelector('.supporting-large');
  const media = item.querySelector('.image');

  if (item === large || mobileQuery.matches) {
    if (media.tagName === 'VIDEO') media.muted = !media.muted;
    return;
  }

  const largeMedia = large.querySelector('.image');

  // Move the actual elements so videos keep their place instead of reloading
  large.appendChild(media);
  item.appendChild(largeMedia);

  // Whatever drops back to a small tile goes quiet
  if (largeMedia.tagName === 'VIDEO') largeMedia.muted = true;

  // Moving a video pauses it, so start both again
  [media, largeMedia].forEach(el => {
    if (el.tagName === 'VIDEO') {
      loadVideo(el);
      el.play().catch(() => {});
    }
  });
}


// ==========================================
// 7. DOM CONTENT LOADED INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  // 1. Theme Check
  applySavedTheme();

  // 2. Mobile video check
  updateMobileVideos();

  // 3. Attach Observers
  document.querySelectorAll(".scroll-in").forEach(box => scrollInObserver.observe(box));
  document.querySelectorAll('.supporting-item, .media-tile, .project-media, .work-container .work').forEach(container => {
    workVideoObserver.observe(container);
  });

  // 4. Swap group click listeners
  document.querySelectorAll('.swap-group .supporting-item').forEach(item => {
    item.addEventListener('click', () => handleSupportingClick(item));
  });

  // 5. Media row tiles: click toggles sound on clips that have it
  document.querySelectorAll('.media-tile video').forEach(video => {
    video.addEventListener('click', () => {
      video.muted = !video.muted;
    });
  });

  // 6. Reel Volume Setup
  document.querySelectorAll('.reel').forEach(reelVideo => {
    reelVideo.volume = 0.2;
  });
});
