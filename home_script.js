







//smooth scrolling with lenis

const lenis = new Lenis({
  // REMOVE duration and easing. Use lerp instead.
  lerp: 0.05, // A value between 0 and 1. (0.1 is standard smooth, 0.05 is icy/heavy)
  
  // Make the wheel feel more powerful/responsive
  wheelMultiplier: 2, 
  
  smoothWheel: true,
});

function raf(time) {
  lenis.raf(time);
  requestAnimationFrame(raf);
}

requestAnimationFrame(raf);












// Handle Intro Video & Hero Images
document.addEventListener('DOMContentLoaded', () => {
  const introSection = document.querySelector('.intro_section');
  const introVideo = document.querySelector('.intro-video');
  const slidingEgoVideo = document.querySelector('.slide');

  // --- 1. HERO VIDEO WARMUP (The "Warmup and Idle" Trick) ---
  if (slidingEgoVideo) {
    slidingEgoVideo.muted = true; // Ensure hardware allows background play
    slidingEgoVideo.play().then(() => {
      slidingEgoVideo.pause();
      slidingEgoVideo.currentTime = 0;
    }).catch(e => {
      slidingEgoVideo.load();
    });
  }

  // Check if user has seen intro. 
  // For testing: change 'true' to 'force-intro' to always play
  const hasSeen = localStorage.getItem('has-seen-intro') === 'true';

  if (hasSeen) {
    // SCENARIO A: Returning User
    if (introSection) introSection.style.display = 'none';
    if (slidingEgoVideo) slidingEgoVideo.play();
    
    // Use requestAnimationFrame to let the video start before the images
    requestAnimationFrame(() => {
        setTimeout(playHeroAnimations, 150);
    });

  } else {
    // SCENARIO B: First-Time Visitor
    if (introVideo) {
      introVideo.addEventListener('ended', () => {
        // 1. Hide Intro (Layout Shift)
        if (introSection) introSection.style.display = 'none';
        
        // 2. Immediate Video Play (Hardware Priority)
        if (slidingEgoVideo) slidingEgoVideo.play();
        
        // 3. Delayed Image Trigger (CPU Relief)
        setTimeout(playHeroAnimations, 200);
        
        localStorage.setItem('has-seen-intro', 'true');
      });

      // Tap to skip
      introVideo.addEventListener('click', () => {
        introVideo.currentTime = introVideo.duration; 
      });
    }
  }
});








// Scroll-triggered animations for elements with the "scroll-in" class

const elements = document.querySelectorAll(".scroll-in")

window.addEventListener("scroll", () => {
    const innerHeightOfWindow = window.innerHeight;

    elements.forEach(box => {
        const boxTop = box.getBoundingClientRect().top

        if(boxTop < innerHeightOfWindow){
            box.classList.add("show")
        } 
        
        /*
        else {
            box.classList.remove("show")
        }
        */

        })
    })


// Scroll to top function for the logo click

// When the user clicks on the button, smoothly scroll to the top using Lenis
function topFunction() {
  // The '0' tells Lenis to scroll to the 0px mark (the very top)
  lenis.scrollTo(0); 
}






//unmute videos

// Select all videos on the page (or change 'video' to a specific class like '.slide')
const toggleMuteVideos = document.querySelectorAll('.unmutable');

toggleMuteVideos.forEach(video => {
  video.addEventListener('click', () => {
    // This flips the mute state: if it's muted, it unmutes; if unmuted, it mutes.
    video.muted = !video.muted;
  });
});








//dark mode toggle

// 1. Run this immediately to check if they have a saved preference
function applySavedTheme() {
  // 1. Check what is saved in the browser
  const savedTheme = localStorage.getItem('site-theme');
  
  // 2. Convert that to a simple true/false
  const isDark = (savedTheme === 'dark');
  
  // 3. Force the HTML tag to match the saved theme
  if (isDark) {
    document.documentElement.classList.add('dark-theme');
  } else {
    document.documentElement.classList.remove('dark-theme');
  }
  
  // 4. Force the images to update based on the saved theme
  // (This also ensures your new mobile/desktop logic runs immediately!)
  updateThemeImages(isDark);
}

// Ensure this runs as soon as the HTML is ready
document.addEventListener('DOMContentLoaded', applySavedTheme);



// 2. Your updated toggle function triggered by the button click
function toggleTheme() {
  // UPDATED: Now toggles the HTML tag
  document.documentElement.classList.toggle('dark-theme');
  const isDark = document.documentElement.classList.contains('dark-theme');
  
  localStorage.setItem('site-theme', isDark ? 'dark' : 'light');
  updateThemeImages(isDark);
}




function playHeroAnimations() {
  // Grab all the animated webps
  const heroImages = document.querySelectorAll('.glued, .sub-text, .navicon');
  
  // Give them their real src so they instantly start animating!
  heroImages.forEach(img => {
    if (img.hasAttribute('data-src')) {
      img.src = img.getAttribute('data-src');
    }
  });
}



function updateThemeImages(isDark) {
  const gluedTypeImg = document.querySelector('.glued');
  const subHeadingImg = document.querySelector('.sub-text');
  const navicons = document.querySelectorAll('.navicon');
  const introSection = document.querySelector('.intro_section');
  
  // 1. Check if the intro is actually hidden yet
  const isIntroFinished = !introSection || introSection.style.display === 'none';
  const isMobile = window.innerWidth <= 768;

  // 2. Set up the paths for both modes
  const themes = {
    dark: {
      glued: isMobile ? 'assets/gluedtype_mobile_dark.webp' : 'assets/gluedtype_desktop_dark.webp',
      sub: 'assets/subheading_dark.webp',
      nav: 'assets/navicon_dark_anim.webp'
    },
    light: {
      glued: isMobile ? 'assets/gluedtype_mobile_light.webp' : 'assets/gluedtype_desktop_light.webp',
      sub: 'assets/subheading_light.webp',
      nav: 'assets/navicon_light_anim.webp'
    }
  };

  const current = isDark ? themes.dark : themes.light;

  // 3. Apply paths: Always update 'data-src', but only update 'src' if intro is done
  if (gluedTypeImg) {
    gluedTypeImg.setAttribute('data-src', current.glued);
    if (isIntroFinished) gluedTypeImg.src = current.glued;
  }
  if (subHeadingImg) {
    subHeadingImg.setAttribute('data-src', current.sub);
    if (isIntroFinished) subHeadingImg.src = current.sub;
  }
  navicons.forEach(icon => {
    icon.setAttribute('data-src', current.nav);
    if (isIntroFinished) icon.src = current.nav;
  });
}

// 4. Trigger the check as soon as the HTML is ready
document.addEventListener('DOMContentLoaded', applySavedTheme);

















//make sure VH DOESNT CHANGE ON FUCKING SHIT ASS MOBILE FUCKING BROWSERS

// 1. Function to calculate and set the exact pixel height
function setStaticViewportHeight() {
  const vh = window.innerHeight * 0.01;
  document.documentElement.style.setProperty('--vh', `${vh}px`);
}

// 2. Run it immediately when the script loads
setStaticViewportHeight();

// 3. Listen for resizes, but ONLY update if the width changes (ignoring URL bar scrolls)
let currentWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth !== currentWidth) {
    currentWidth = window.innerWidth;
    setStaticViewportHeight();
  }
});













//Video Lazy Loader!!!

// 1. Create the Intersection Observer
const workVideoObserver = new IntersectionObserver((entries, observer) => {
  entries.forEach(entry => {
    
    // When the container scrolls into view
    if (entry.isIntersecting) {
      
      // Add your CSS class to trigger the visual fade-in
      entry.target.classList.add('show');

      // Find the specific video inside this container
      const video = entry.target.querySelector('video.image');
      
      // If the video exists and has our hidden data-src
      if (video && video.hasAttribute('data-src')) {
        // 1. Swap the source
        video.src = video.getAttribute('data-src');
        video.removeAttribute('data-src'); 
        
        // 2. Force the mute BEFORE loading
        video.muted = true; 
        
        // 3. Tell the browser to process the new file
        video.load();
      }

      // Stop watching this specific container so it doesn't run again
      observer.unobserve(entry.target);
    }
  });
}, {
  // PRO-TIP: This makes the video start loading 200px BEFORE it enters the screen,
  // making the playback feel completely instantaneous to the user!
  rootMargin: "0px 0px 200px 0px" 
});

// 2. Attach the observer ONLY to your featured work scroll containers
document.querySelectorAll('.work.scroll-in').forEach(container => {
  workVideoObserver.observe(container);
});