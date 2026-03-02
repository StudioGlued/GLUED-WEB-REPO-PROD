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

function topFunction() {
  lenis.scrollTo(0);
}


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
  const introSection = document.querySelector('.intro_section');
  const isIntroFinished = !introSection || introSection.style.display === 'none';
  const isMobile = window.innerWidth <= 768;
  const theme = isDark ? 'dark' : 'light';

  // Helper to update images cleanly
  const updateImage = (selector, src) => {
    const elements = document.querySelectorAll(selector);
    elements.forEach(el => {
      el.setAttribute('data-src', src);
      if (isIntroFinished) el.src = src;
    });
  };

  const gluedSrc = `assets/gluedtype_${isMobile ? 'mobile' : 'desktop'}_${theme}.webp`;
  
  updateImage('.glued', gluedSrc);
  updateImage('.sub-text', `assets/subheading_${theme}.webp`);
  updateImage('.navicon', `assets/navicon_${theme}_anim.webp`);
}

function applySavedTheme() {
  const isDark = localStorage.getItem('site-theme') === 'dark';
  document.documentElement.classList.toggle('dark-theme', isDark);
  updateThemeImages(isDark);
}

function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark-theme');
  localStorage.setItem('site-theme', isDark ? 'dark' : 'light');
  updateThemeImages(isDark);
}


// ==========================================
// 4. INTRO SEQUENCE & HERO ANIMATIONS
// ==========================================
function playHeroAnimations() {
  const heroImages = document.querySelectorAll('.glued, .sub-text, .navicon');
  heroImages.forEach(img => {
    if (img.hasAttribute('data-src')) {
      img.src = img.getAttribute('data-src');
    }
  });
}

function initIntroSequence() {
  const introSection = document.querySelector('.intro_section');
  const introVideo = document.querySelector('.intro-video');
  const slidingEgoImg = document.querySelector('.slide'); 
  const hasSeen = localStorage.getItem('has-seen-intro') === 'true'; // Changed to check for 'true' to avoid double negatives

  function finishIntro() {
    if (document.documentElement.classList.contains('intro-finished')) return;

    if (introSection) introSection.style.display = 'none';
    
    if (slidingEgoImg && slidingEgoImg.hasAttribute('data-src')) {
      slidingEgoImg.src = slidingEgoImg.getAttribute('data-src');
    }
    
    setTimeout(playHeroAnimations, 150);
    localStorage.setItem('has-seen-intro', 'true');
    document.documentElement.classList.add('intro-finished');
    window.removeEventListener('scroll', handleIntroScroll);
  }

  function handleIntroScroll() {
    if (window.scrollY > 10) finishIntro();
  }

  if (hasSeen) {
    finishIntro(); 
  } else if (introVideo && introSection) {
    introVideo.addEventListener('ended', finishIntro);
    introVideo.addEventListener('click', finishIntro); 
    // Added passive: true for scroll performance
    window.addEventListener('scroll', handleIntroScroll, { passive: true }); 
    
    const introObserver = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) {
        finishIntro();
        introObserver.disconnect(); 
      }
    }, { threshold: 0 });
    
    introObserver.observe(introSection);
  }
}


// ==========================================
// 5. INTERSECTION OBSERVERS (ANIMATIONS & LAZY LOAD)
// ==========================================

// Replaced the expensive scroll listener with an IntersectionObserver
const scrollInObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add("show");
      // Optional: unobserve if you only want it to animate once
      // scrollInObserver.unobserve(entry.target); 
    } else {
      // Remove this else block if you want the animation to happen only once
      entry.target.classList.remove("show"); 
    }
  });
}, { threshold: 0.1 }); // Triggers when 10% of the element is visible


// Video Lazy Loader
const workVideoObserver = new IntersectionObserver((entries, observer) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('show');
      const video = entry.target.querySelector('video.image, video.unmutable, .reel-container.scroll-in');
      
      if (video && video.hasAttribute('data-src')) {
        video.src = video.getAttribute('data-src');
        video.removeAttribute('data-src'); 
        video.muted = true; 
        video.load();
      }
      observer.unobserve(entry.target);
    }
  });
}, { rootMargin: "0px 0px 200px 0px" });


// ==========================================
// 6. DOM CONTENT LOADED INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  // 1. Theme Check
  applySavedTheme();
  
  // 2. Intro Check
  initIntroSequence();

  // 3. Attach Observers
  document.querySelectorAll(".scroll-in").forEach(box => scrollInObserver.observe(box));
  document.querySelectorAll('.work.scroll-in, .box-container, .reel-container').forEach(container => {
    workVideoObserver.observe(container);
  });

  // 4. Unmute video click listeners
  document.querySelectorAll('.unmutable').forEach(video => {
    video.addEventListener('click', () => {
      video.muted = !video.muted;
    });
  });

  // 5. Reel Volume Setup (Wrapped in safety check)
  const reelVideo = document.querySelector('.reel');
  if (reelVideo) {
    reelVideo.volume = 0.2;
  }
});