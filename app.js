class GitHubRepositoryFetcher {
  // Cache response promises to prevent duplicate requests
  #requestCache = new Map();

  // In-memory rate limit cache
  #rateLimitInfo = {
    limit: Infinity,
    remaining: Infinity,
    reset: 0,
  };
  #rateLimitCheckPromise = null;
  #lastCheckTimestamp = 0;
  #RATE_CHECK_THRESHOLD = 60000;
  constructor() {
    this.elements = this.initializeElements();
    this.state = {
      currentLanguage: "",
      repositoryCache: new Map(),
      rateLimit: {
        limit: null,
        remaining: null,
        reset: null,
      },
      analyticsData: new Map(),
      isLoading: false,
      repositories: [],
      currentRepo: null,
      lastFetchTimestamp: null,
      errorRetryCount: 0,
      settings: CONFIG,
    };

    this.languages = SUPPORTED_LANGUAGES;
    this.initializeApp();
  }

  // Initialization Methods
  async initializeApp() {
    console.log(this.state.repositoryCache.size);

    await this.initializeDatabase();
    this.populateLanguageDropdown();
    this.setupEventListeners();
    this.setupKeyboardShortcuts();
    this.setupIntersectionObserver();
  }

  async initializeDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("GitHubExplorerDB", 1);

      request.onerror = () =>
        reject(new Error("Failed to initialize IndexedDB"));

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains("repositories")) {
          db.createObjectStore("repositories", { keyPath: "language" });
        }
        if (!db.objectStoreNames.contains("analytics")) {
          db.createObjectStore("analytics", {
            keyPath: "id",
            autoIncrement: true,
          });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
    });
  }

  initializeElements() {
    const elements = {};
    const requiredElements = [
      "language-select",
      "fetch-btn",
      "refresh-btn",
      "loading",
      "error",
      "repository-info",
      "repo-name",
      "repo-description",
      "repo-stars",
      "repo-forks",
      "repo-issues",
      "repo-language",
      "repo-created",
      "repo-updated",
      "repo-watchers",
    ];

    requiredElements.forEach((id) => {
      const element = document.getElementById(id);

      if (!element) {
        throw new Error(`Required element ${id} not found`);
      }
      elements[id] = element;
    });

    return elements;
  }

  // Setup Methods
  populateLanguageDropdown() {
    const fragment = document.createDocumentFragment();
    this.languages.forEach((language) => {
      const option = document.createElement("option");
      option.value = language;
      option.textContent = language;
      fragment.appendChild(option);
    });
    this.elements["language-select"].appendChild(fragment);
  }

  setupEventListeners() {
    this.debouncedFetch = debounce(this.handleFetchClick.bind(this), 300);
    this.debouncedRefresh = debounce(this.handleRefreshClick.bind(this), 300);

    this.elements["fetch-btn"].addEventListener("click", this.debouncedFetch);
    this.elements["refresh-btn"].addEventListener(
      "click",
      this.debouncedRefresh
    );
    this.elements["language-select"].addEventListener(
      "change",
      this.handleLanguageChange.bind(this)
    );

    window.addEventListener("online", () =>
      this.handleConnectivityChange(true)
    );
    window.addEventListener("offline", () =>
      this.handleConnectivityChange(false)
    );
    window.addEventListener("focus", () => this.checkCacheExpiration());

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        checkRateLimit();
      }
    });
  }

  setupKeyboardShortcuts() {
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key === "f") {
        e.preventDefault();
        this.handleFetchClick();
      } else if (e.ctrlKey && e.key === "r") {
        e.preventDefault();
        this.handleRefreshClick();
      }
    });
  }

  setupIntersectionObserver() {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("fade-in");
          }
        });
      },
      { threshold: 0.1 }
    );

    observer.observe(this.elements["repository-info"]);
  }

  async fetchRepositoriesWithRetry(language, retries = 0) {
    // Check if request is already in progress
    const cacheKey = `${language}-${this.state.settings.MIN_STARS}`;
    if (this.#requestCache.has(cacheKey)) {
      return this.#requestCache.get(cacheKey);
    }

    const promise = this.#executeFetch(language, retries);
    this.#requestCache.set(cacheKey, promise);

    // Clean up cache after request completes
    promise.finally(() => this.#requestCache.delete(cacheKey));

    return promise;
  }

  async #executeFetch(language, retries) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.state.settings.FETCH_TIMEOUT
    );

    try {
      const [params, cachedData] = await Promise.all([
        this.#buildParams(language),
        this.loadFromIndexedDB("repositories", language),
      ]);

      const response = await fetch(
        `${this.state.settings.API_BASE_URL}?${params}`,
        {
          headers: {
            Accept: "application/vnd.github.v3+json",
            "If-None-Match": cachedData?.etag || "",
          },
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      // Fast-path for cached responses
      if (response.status === 304 && cachedData) {
        this.#updateRateLimitFast(response.headers);
        return cachedData.data;
      }

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      const validatedData = this.#validateAndFilterFast(data);

      // Parallel operations for performance
      await Promise.all([
        this.updateCache(language, {
          data: validatedData,
          etag: response.headers.get("etag"),
          timestamp: Date.now(),
        }),
        this.#updateRateLimitFast(response.headers),
      ]);

      return validatedData;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Request timed out");
      }

      if (retries < this.state.settings.MAX_RETRIES) {
        const delay = this.state.settings.RETRY_DELAY * (1 << retries); // Faster than Math.pow
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.fetchRepositoriesWithRetry(language, retries + 1);
      }
      throw error;
    }
  }

  #buildParams(language) {
    return new URLSearchParams({
      q: `language:${language} stars:>=${this.state.settings.MIN_STARS}`,
      sort: "stars",
      order: "desc",
      per_page: this.state.settings.PAGE_SIZE,
    });
  }

  #validateAndFilterFast(data) {
    if (!data?.items?.length)
      throw new Error("Invalid repository data received");

    const minStars = this.state.settings.MIN_STARS;
    const validatedItems = data.items.filter(
      (repo) =>
        repo?.full_name &&
        typeof repo.stargazers_count === "number" &&
        repo.stargazers_count >= minStars &&
        !repo.archived &&
        !repo.disabled
    );

    return { ...data, items: validatedItems };
  }

  #updateRateLimitFast(headers) {
    const limit = parseInt(headers.get("x-ratelimit-limit"));
    const remaining = parseInt(headers.get("x-ratelimit-remaining"));
    const reset = parseInt(headers.get("x-ratelimit-reset"));

    if (!limit || !remaining || !reset) return false;

    // Update in-memory cache
    this.#rateLimitInfo = { limit, remaining, reset };

    // Update state
    this.state.rateLimit = { ...this.#rateLimitInfo };

    // Batch analytics update
    queueMicrotask(() => {
      this.saveToIndexedDB("analytics", {
        timestamp: Date.now(),
        action: "rate_limit_update",
        limit,
        remaining,
        reset,
      });
    });

    // Handle low rate limit warnings
    if (remaining < 10) {
      const resetDate = new Date(reset * 1000);
      this.showWarning(
        `Rate limit low: ${remaining} requests remaining. Resets at ${resetDate.toLocaleTimeString()}`
      );
    }

    // Handle rate limit exhaustion
    if (remaining === 0) {
      const now = Date.now() / 1000;
      const minutesUntilReset = Math.ceil((reset - now) / 60);
      const resetDate = new Date(reset * 1000);

      this.showError(
        `Rate limit exceeded. Wait ${minutesUntilReset} minutes until ${resetDate.toLocaleTimeString()}`
      );

      // Disable buttons
      const { "fetch-btn": fetchBtn, "refresh-btn": refreshBtn } =
        this.elements;
      fetchBtn.disabled = refreshBtn.disabled = true;

      // Schedule re-enable
      setTimeout(() => {
        fetchBtn.disabled = refreshBtn.disabled = false;
        this.hideError();
      }, (reset - now) * 1000);
    }

    return true;
  }

  async checkRateLimit() {
    // Return cached promise if check is in progress
    if (this.#rateLimitCheckPromise) {
      return this.#rateLimitCheckPromise;
    }

    // Use cached rate limit if recent
    const now = Date.now();
    if (now - this.#lastCheckTimestamp < this.#RATE_CHECK_THRESHOLD) {
      return this.#rateLimitInfo;
    }

    try {
      this.#rateLimitCheckPromise = this.#executeRateLimitCheck();
      const result = await this.#rateLimitCheckPromise;
      return result;
    } finally {
      this.#rateLimitCheckPromise = null;
    }
  }

  async #executeRateLimitCheck() {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

      const response = await fetch("https://api.github.com/rate_limit", {
        headers: { Accept: "application/vnd.github.v3+json" },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();

      // Update both caches
      this.#rateLimitInfo = data.rate;
      this.state.rateLimit = data.rate;
      this.#lastCheckTimestamp = Date.now();

      // Handle low rate limit warning
      if (data.rate.remaining < 10) {
        const resetDate = new Date(data.rate.reset * 1000);
        this.showWarning(
          `Rate limit low: ${data.rate.remaining} requests remaining. ` +
            `Resets at ${resetDate.toLocaleTimeString()}`
        );
      }

      // Queue analytics update
      queueMicrotask(() => {
        this.saveToIndexedDB("analytics", {
          timestamp: Date.now(),
          action: "rate_limit_check",
          ...data.rate,
        });
      });

      return data.rate;
    } catch (error) {
      if (error.name === "AbortError") {
        console.warn("Rate limit check timed out");
        return this.#rateLimitInfo; // Return cached data on timeout
      }
      console.warn("Failed to check rate limit:", error);
      return this.#rateLimitInfo; // Return cached data on error
    }
  }

  async prefetchRepositories(language) {
    try {
      this.setLoadingState(true, "Prefetching repositories...");
      await this.fetchRepositoriesWithRetry(language);
    } catch (error) {
      console.warn("Prefetch failed:", error);
    } finally {
      this.setLoadingState(false);
    }
  }

  setLoadingState(isLoading, message = "Loading...") {
    this.state.isLoading = isLoading;
    const loadingEl = this.elements["loading"];

    if (isLoading) {
      loadingEl.querySelector("span").textContent = message;
      loadingEl.classList.remove("hidden");
      this.elements["fetch-btn"].disabled = true;
      this.elements["refresh-btn"].disabled = true;
    } else {
      loadingEl.classList.add("hidden");
      this.elements["fetch-btn"].disabled = false;
      this.elements["refresh-btn"].disabled = false;
    }
  }

  // Cache Management Methods
  async saveToIndexedDB(storeName, data) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], "readwrite");
      const store = transaction.objectStore(storeName);
      const request = store.put(data);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error("Failed to save to IndexedDB"));
    });
  }

  async loadFromIndexedDB(storeName, key) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], "readonly");
      const store = transaction.objectStore(storeName);
      const request = store.get(key);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new Error("Failed to load from IndexedDB"));
    });
  }

  async updateCache(language, data) {
    // Update the cache memory
    this.state.repositoryCache.set(language, data);
    await this.saveToIndexedDB("repositories", { language, ...data });

    if (this.state.repositoryCache.size > this.state.settings.MAX_CACHE_SIZE) {
      const oldestKey = this.state.repositoryCache.keys().next().value;
      this.state.repositoryCache.delete(oldestKey);
    }

    await this.saveToIndexedDB("analytics", {
      timestamp: Date.now(),
      action: "cache_update",
      language,
      cacheSize: this.state.repositoryCache.size,
    });
  }

  async checkCacheExpiration() {
    try {
      // Get all stored repositories from IndexedDB
      const transaction = this.db.transaction(["repositories"]);
      const store = transaction.objectStore("repositories");
      const request = store.getAll();

      request.onsuccess = async () => {
        const repositories = request.result;
        const expiredRepositories = [];

        // Check each repository's timestamp
        repositories.forEach((repo) => {
          if (this.isCacheExpired(repo.timestamp)) {
            expiredRepositories.push(repo.language);
            this.state.repositoryCache.delete(repo.language);
          }
        });

        // Remove expired entries from IndexedDB
        if (expiredRepositories.length > 0) {
          const deleteTransaction = this.db.transaction(
            ["repositories"],
            "readwrite"
          );
          const deleteStore = deleteTransaction.objectStore("repositories");

          expiredRepositories.forEach((language) => {
            deleteStore.delete(language);
          });

          // Log cache cleanup analytics
          await this.saveToIndexedDB("analytics", {
            timestamp: Date.now(),
            action: "cache_cleanup",
            expiredEntries: expiredRepositories.length,
            languages: expiredRepositories,
          });

          // If current language's cache was expired, trigger a prefetch
          if (
            this.state.currentLanguage &&
            expiredRepositories.includes(this.state.currentLanguage)
          ) {
            this.prefetchRepositories(this.state.currentLanguage);
          }
        }
      };

      request.onerror = () => {
        console.warn("Failed to check cache expiration:", request.error);
      };
    } catch (error) {
      console.warn("Error during cache expiration check:", error);
    }
  }

  // Event Handlers
  async handleLanguageChange(event) {
    const newLanguage = event.target.value;
    this.hideRepoInfo();
    this.state.currentLanguage = newLanguage;

    if (newLanguage) {
      const cachedData = await this.loadFromIndexedDB(
        "repositories",
        newLanguage
      );
      if (!cachedData || this.isCacheExpired(cachedData.timestamp)) {
        this.prefetchRepositories(newLanguage);
      }
    }
  }

  async handleFetchClick() {
    const language = this.elements["language-select"].value;
    if (!language) {
      this.showError("Please select a programming language.");
      return;
    }
    await this.fetchRandomRepository(language);
  }

  async handleRefreshClick() {
    if (this.state.currentLanguage) {
      await this.fetchRandomRepository(this.state.currentLanguage);
    }
  }

  handleConnectivityChange(isOnline) {
    this.elements["fetch-btn"].disabled = !isOnline;
    this.elements["refresh-btn"].disabled = !isOnline;
    if (!isOnline) {
      this.showError("You are offline. Please check your internet connection.");
    } else {
      this.hideError();
    }
  }

  // UI Update Methods
  setLoadingState(isLoading, message = "Loading...") {
    this.state.isLoading = isLoading;
    const loadingEl = this.elements["loading"];

    if (isLoading) {
      loadingEl.querySelector("span").textContent = message;
      loadingEl.classList.remove("hidden");
      this.elements["fetch-btn"].disabled = true;
      this.elements["refresh-btn"].disabled = true;
    } else {
      loadingEl.classList.add("hidden");
      this.elements["fetch-btn"].disabled = false;
      this.elements["refresh-btn"].disabled = false;
    }
  }
  async fetchRandomRepository(language) {
    if (this.state.isLoading) return;

    this.setLoadingState(true);
    this.hideError();
    this.hideRepoInfo();

    try {
      const startTime = performance.now(); // Log start time

      const cachedData = this.state.repositoryCache.get(language);

      if (cachedData) {
        console.log(`Cache Hit for ${language}`);
        const age = (Date.now() - cachedData.timestamp) / 1000; // Convert to seconds
        console.log(`Cache Age: ${age} seconds`);
      } else {
        console.log(`Cache Miss for ${language}`);
      }

      let data;

      // Check if the cached data is valid
      if (
        cachedData &&
        Date.now() - cachedData.timestamp < this.state.settings.CACHE_DURATION
      ) {
        data = cachedData.data;
      } else {
        // Fetch new data and update cache
        data = await this.fetchRepositoriesWithRetry(language);
        this.state.repositoryCache.set(language, {
          data,
          timestamp: Date.now(),
        });
      }

      const endTime = performance.now(); // Log end time
      console.log(
        `Execution time: ${(endTime - startTime).toFixed(2)} milliseconds`
      );

      // Check if data contains repositories
      if (!data.items.length) {
        throw new Error("No repositories found.");
      }

      // Update repository data and display it
      this.updateRepositoryData(data);
      this.displayRandomRepository();
    } catch (error) {
      this.handleError(error);
    } finally {
      this.setLoadingState(false);
    }
  }

  updateRepositoryData(data) {
    this.state.repositories = data.items;
  }

  displayRandomRepository() {
    const randomIndex = Math.floor(
      Math.random() * this.state.repositories.length
    );
    const repo = this.state.repositories[randomIndex];
    this.state.currentRepo = repo;

    this.updateUIWithRepository(repo);
    this.showRepoInfo();
    this.showRefreshButton();
  }

  updateUIWithRepository(repo) {
    const elements = this.elements;
    elements["repo-name"].href = repo.html_url;
    elements["repo-name"].textContent = repo.full_name;
    elements["repo-description"].textContent =
      repo.description || "No description available";
    elements["repo-stars"].textContent = formatNumber(repo.stargazers_count);
    elements["repo-forks"].textContent = formatNumber(repo.forks_count);
    elements["repo-issues"].textContent = formatNumber(repo.open_issues_count);
    elements["repo-language"].textContent = repo.language;
    elements["repo-updated"].textContent = new Date(
      repo.updated_at
    ).toLocaleDateString();
    elements["repo-created"].textContent = new Date(
      repo.created_at
    ).toLocaleDateString();
    elements["repo-watchers"].textContent = repo.watchers_count;

    const cacheStatusElement = document.getElementById("cache-status");
    const cachedLanguagesCount = this.state.repositoryCache.size;
    cacheStatusElement.textContent = `Cached Languages: ${cachedLanguagesCount}`;
  }

  // Utility Methods

  isCacheExpired(timestamp) {
    return Date.now() - timestamp > this.state.settings.CACHE_DURATION;
  }

  validateAndFilterRepositories(data) {
    if (!data || !Array.isArray(data.items)) {
      throw new Error("Invalid repository data received");
    }

    const validatedItems = data.items.filter((repo) => {
      return (
        repo &&
        typeof repo.full_name === "string" &&
        typeof repo.stargazers_count === "number" &&
        repo.stargazers_count >= this.state.settings.MIN_STARS &&
        !repo.archived &&
        !repo.disabled
      );
    });

    return { ...data, items: validatedItems };
  }

  // Show/Hide UI Elements
  showError(message) {
    this.elements["error"].textContent = message;
    this.elements["error"].classList.remove("hidden");
  }

  hideError() {
    this.elements["error"].classList.add("hidden");
  }

  showRepoInfo() {
    this.elements["repository-info"].classList.remove("hidden");
  }

  hideRepoInfo() {
    this.elements["repository-info"].classList.add("hidden");
  }

  showRefreshButton() {
    this.elements["refresh-btn"].classList.remove("hidden");
  }

  handleError(error) {
    console.error("Error:", error);
    this.showError(error.message || "Failed to fetch repository.");
  }

  showWarning(message) {
    let warningEl = document.getElementById("warning");
    if (!warningEl) {
      warningEl = document.createElement("div");
      warningEl.id = "warning";
      warningEl.className = "warning";
      this.elements["repository-info"].parentNode.insertBefore(
        warningEl,
        this.elements["repository-info"]
      );
    }
    warningEl.textContent = message;
    warningEl.classList.remove("hidden");

    setTimeout(() => warningEl.classList.add("hidden"), 5000);
  }
}

// Initialize the app when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  try {
    new GitHubRepositoryFetcher();
  } catch (error) {
    console.error("Failed to initialize:", error);
    document.body.innerHTML = `
        <div class="error">
          Failed to initialize the application. Please refresh the page or contact support.
        </div>
      `;
  }
});
