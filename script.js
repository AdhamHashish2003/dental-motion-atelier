const revealItems = document.querySelectorAll(".reveal");

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      }
    });
  },
  {
    threshold: 0.16,
    rootMargin: "0px 0px -40px 0px",
  }
);

revealItems.forEach((item) => revealObserver.observe(item));

document.querySelector(".play-ring")?.addEventListener("click", () => {
  document.querySelector("#work")?.scrollIntoView({ behavior: "smooth" });
});

document.querySelector(".contact-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  const status = event.currentTarget.querySelector(".form-status");
  const originalText = button.textContent;
  button.textContent = "Request received";
  button.disabled = true;
  if (status) {
    status.textContent = "Thanks. Your luxury concept request is ready for follow-up.";
  }

  window.setTimeout(() => {
    button.textContent = originalText;
    button.disabled = false;
    if (status) {
      status.textContent = "";
    }
  }, 2200);
});
