







//smooth scrolling with lenis

const lenis = new Lenis({
  // REMOVE duration and easing. Use lerp instead.
  lerp: 0.05, // A value between 0 and 1. (0.1 is standard smooth, 0.05 is icy/heavy)
  
  // Make the wheel feel more powerful/responsive
  wheelMultiplier: 3, 
  
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
  const heroImages = document.querySelectorAll('.hero img[data-src]');
  
  // A quick helper function to load our images so we don't write it twice
  function loadHeroImages() {
    heroImages.forEach(img => {
      img.src = img.getAttribute('data-src');
    });
  }

  // Check if they have seen the intro before
  if (localStorage.getItem('has-seen-intro') === 'true') {
    
    // SCENARIO A: Returning User
    // Hide the intro immediately and load the images instantly
    if (introSection) introSection.style.display = 'none';
    loadHeroImages();
    
  } else {
    
    // SCENARIO B: First-Time Visitor
    // Let the video play, wait for it to end, then show images and save state
    if (introVideo) {
      introVideo.addEventListener('ended', () => {
        if (introSection) introSection.style.display = 'none';
        loadHeroImages();
        
        // Save to local storage so it skips next time!
        localStorage.setItem('has-seen-intro', 'true');
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
const toggleMuteVideos = document.querySelectorAll('video');

toggleMuteVideos.forEach(video => {
  video.addEventListener('click', () => {
    // This flips the mute state: if it's muted, it unmutes; if unmuted, it mutes.
    video.muted = !video.muted;
  });
});







//dark mode toggle

// 1. Run this immediately to check if they have a saved preference
function applySavedTheme() {
  const savedTheme = localStorage.getItem('site-theme');
  if (savedTheme === 'dark') {
    // UPDATED: Now targets the HTML tag
    document.documentElement.classList.add('dark-theme');
    updateThemeImages(true); 
  }
}


// 2. Your updated toggle function triggered by the button click
function toggleTheme() {
  // UPDATED: Now toggles the HTML tag
  document.documentElement.classList.toggle('dark-theme');
  const isDark = document.documentElement.classList.contains('dark-theme');
  
  localStorage.setItem('site-theme', isDark ? 'dark' : 'light');
  updateThemeImages(isDark);
}


// 3. A helper function to swap all the images 
function updateThemeImages(isDark) {
  const gluedTypeImg = document.querySelector('.glued');
  const subHeadingImg = document.querySelector('.sub-text');
  
  // NEW: Select ALL navicons on the page
  const navicons = document.querySelectorAll('.navicon'); 
  
  if (isDark) {
    // Update main hero images
    if (gluedTypeImg) {
      gluedTypeImg.src = 'assets/gluedtype_desktop_dark.webp';
      gluedTypeImg.setAttribute('data-src', 'assets/gluedtype_desktop_dark.webp');
    }
    if (subHeadingImg) {
      subHeadingImg.src = 'assets/subheading_dark.webp';
      subHeadingImg.setAttribute('data-src', 'assets/subheading_dark.webp');
    }
    
    // NEW: Loop through and update all navicons to the dark version
    navicons.forEach(icon => {
      icon.src = 'assets/navicon_dark.png';
    });

  } else {
    // Update main hero images
    if (gluedTypeImg) {
      gluedTypeImg.src = 'assets/gluedtype_desktop_light.webp';
      gluedTypeImg.setAttribute('data-src', 'assets/gluedtype_desktop_light.webp');
    }
    if (subHeadingImg) {
      subHeadingImg.src = 'assets/subheading_light.webp';
      subHeadingImg.setAttribute('data-src', 'assets/subheading_light.webp');
    }
    
    // NEW: Loop through and update all navicons to the light version
    navicons.forEach(icon => {
      icon.src = 'assets/navicon_light.png';
    });
  }
}


// 4. Trigger the check as soon as the HTML is ready
document.addEventListener('DOMContentLoaded', applySavedTheme);