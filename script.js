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

document.querySelector(".contact-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  const status = form.querySelector(".form-status");
  const originalText = button.textContent;
  const formData = new FormData(form);

  button.textContent = "Sending...";
  button.disabled = true;
  if (status) {
    status.textContent = "";
  }

  try {
    const response = await fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: formData.get("name"),
        email: formData.get("email"),
        offer: formData.get("offer"),
      }),
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.message || "The message could not be sent.");
    }

    button.textContent = "Request sent";
    form.reset();
    if (status) {
      status.textContent = result.message;
    }
    window.setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
    }, 2200);
  } catch (error) {
    button.textContent = originalText;
    button.disabled = false;
    if (status) {
      status.textContent = error.message;
    }
  }
});
