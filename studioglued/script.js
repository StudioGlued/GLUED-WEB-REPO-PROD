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

    